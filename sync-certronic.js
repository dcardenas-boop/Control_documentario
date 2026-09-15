// ============================================================
// Sync Certronic -> Supabase
//
// Loguea en el portal de Certronic, lee las tablas de Vehiculos
// y Personal (paginando hasta traer todo), y las sube a Supabase
// con upsert (no duplica filas si se corre todos los dias).
//
// Requiere Node.js >= 20 (usa fetch global y Headers.getSetCookie()).
//
// Variables de entorno requeridas (se configuran como Secrets en
// GitHub Actions, nunca se hardcodean en este archivo):
//   CERTRONIC_USER
//   CERTRONIC_PASS
//   SUPABASE_URL                 (ej: https://tuproyecto.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY    (la "service_role" key, NO la anon key)
// ============================================================

import * as cheerio from "cheerio";

const BASE = "https://gro.certronic.io/portal/pages";
const LOGIN_URL = `${BASE}/login.php`;
const VEHICULOS_URL = `${BASE}/contratista-tablaVehiculos.php`;
const EMPLEADOS_URL = `${BASE}/contratista-tablaEmpleados.php`;

const {
  CERTRONIC_USER,
  CERTRONIC_PASS,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

function requireEnv() {
  const missing = ["CERTRONIC_USER", "CERTRONIC_PASS", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
    .filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error("Faltan variables de entorno: " + missing.join(", "));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------
// Manejo de cookies (el portal usa sesion via PHPSESSID + AWSALB)
// ------------------------------------------------------------
function mergeCookies(existingHeader, response) {
  const jar = new Map();
  if (existingHeader) {
    existingHeader.split(";").forEach((pair) => {
      const [k, ...v] = pair.trim().split("=");
      if (k) jar.set(k, v.join("="));
    });
  }
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);

  setCookies.forEach((sc) => {
    const first = sc.split(";")[0];
    const [k, ...v] = first.trim().split("=");
    if (k) jar.set(k, v.join("="));
  });

  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractToken(html) {
  const m = html.match(/id="token"[^>]*value="([^"]*)"/);
  return m ? m[1] : "";
}

// Detecta el nombre interno del objeto de la tabla (ej. 'ListaVehiculos')
// leyendolo del propio HTML en vez de asumirlo, por si difiere entre
// Vehiculos y Empleados.
function extractObjectName(html) {
  const m = html.match(/getElementById\('objeto'\)\.value\s*=\s*'([^']+)'/);
  return m ? m[1] : null;
}

// ------------------------------------------------------------
// Login
// ------------------------------------------------------------
async function login() {
  let res = await fetch(LOGIN_URL);
  let cookies = mergeCookies("", res);
  const html = await res.text();
  const token = extractToken(html);

  const body = new URLSearchParams({
    objeto: "",
    evento: "iniciarSesion_Click",
    parametros: "",
    token,
    User: CERTRONIC_USER,
    Password: CERTRONIC_PASS,
    MantenerSesion: "S",
  });

  res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookies,
    },
    body,
    redirect: "manual",
  });

  cookies = mergeCookies(cookies, res);

  // Si el login fallo, el portal normalmente re-renderiza el propio
  // login.php (en vez de redirigir a contratista-home.php). Lo
  // chequeamos pidiendo una pagina protegida a continuacion; si nos
  // devuelve el formulario de login de nuevo, las credenciales
  // fallaron.
  const check = await fetch(VEHICULOS_URL, { headers: { Cookie: cookies } });
  const checkHtml = await check.text();
  if (checkHtml.includes('id="Password"') || checkHtml.includes('name="Password"')) {
    throw new Error(
      "El login no funciono (nos sigue mostrando la pantalla de login). Revisa CERTRONIC_USER / CERTRONIC_PASS."
    );
  }

  return cookies;
}

// ------------------------------------------------------------
// POST generico al mismo patron objeto/evento/parametros/token
// ------------------------------------------------------------
async function postForm(url, cookies, { objeto, evento, parametros, token }) {
  const body = new URLSearchParams({ objeto, evento, parametros, token });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookies,
    },
    body,
  });
  const html = await res.text();
  return { html, token: extractToken(html) || token };
}

// ------------------------------------------------------------
// Parseo de tabla generico: usa el thead para mapear columnas
// por nombre, y separa el Estado desde el <span class="badge">.
// ------------------------------------------------------------
function parseTable($, tableSelector) {
  const $table = $(tableSelector);
  const headers = [];
  $table.find("thead th").each((_, th) => {
    headers.push($(th).text().trim().replace(/\s+/g, " "));
  });

  const rows = [];
  $table.find("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length === 0) return;
    const row = {};
    cells.each((i, td) => {
      const header = headers[i] || `col${i}`;
      const $td = $(td);
      const badge = $td.find(".badge");
      row[header] = badge.length ? badge.text().trim() : $td.text().trim().replace(/\s+/g, " ");
    });
    rows.push(row);
  });

  return rows;
}

function ddmmyyyyToIso(s) {
  if (!s) return null;
  const m = s.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo}-${d}`;
}

// ------------------------------------------------------------
// Trae TODAS las filas de una tabla paginada (Vehiculos o Empleados)
// ------------------------------------------------------------
async function fetchAllRows(url, cookies, tableSelector) {
  let res = await fetch(url, { headers: { Cookie: cookies } });
  let html = await res.text();
  let token = extractToken(html);
  const objeto = extractObjectName(html);
  if (!objeto) {
    throw new Error(`No se pudo detectar el nombre interno del objeto de tabla en ${url}`);
  }

  // Subir a 100 filas por pagina, arrancando en la pagina 1
  ({ html, token } = await postForm(url, cookies, {
    objeto,
    evento: "Paginar",
    parametros: "1,100",
    token,
  }));

  let $ = cheerio.load(html);
  let allRows = parseTable($, tableSelector);

  const totalMatch = html.match(/Mostrando:\s*\d+\s*de\s*(\d+)/i);
  const total = totalMatch ? parseInt(totalMatch[1], 10) : allRows.length;

  let page = 1;
  const seenKeys = new Set(allRows.map((r) => JSON.stringify(r)));

  while (allRows.length < total && page < 50) {
    page += 1;
    await sleep(400); // ser educados con el servidor
    ({ html, token } = await postForm(url, cookies, {
      objeto,
      evento: "IrPagina",
      parametros: String(page),
      token,
    }));
    $ = cheerio.load(html);
    const rows = parseTable($, tableSelector);
    if (rows.length === 0) break;

    let addedNew = false;
    for (const r of rows) {
      const key = JSON.stringify(r);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allRows.push(r);
        addedNew = true;
      }
    }
    if (!addedNew) break; // evita loop infinito si el paginado no avanza
  }

  return allRows;
}

// ------------------------------------------------------------
// Mapeo de filas crudas -> filas para Supabase
// ------------------------------------------------------------
function mapVehiculo(raw) {
  return {
    dominio: raw["Dominio"],
    marca: raw["Marca"] || null,
    modelo: raw["Modelo"] || null,
    estado: normalizeEstado(raw["Estado"]),
    motivo: (raw["Motivo No Acceso"] || "").trim() || null,
    fecha: ddmmyyyyToIso(raw["Fecha"]),
  };
}

function mapPersonal(raw) {
  return {
    apellido: raw["Apellido"],
    nombre: raw["Nombre"],
    cuil: String(raw["Cuil"] || "").replace(/\D/g, ""),
    empresa: raw["Empresa"] || null,
    funcion: raw["Funcion"] || raw["Función"] || null,
    estado: normalizeEstado(raw["Estado"]),
    motivo: (raw["Motivo No Acceso"] || "").trim() || null,
    fecha: ddmmyyyyToIso(raw["Fecha"]),
  };
}

function normalizeEstado(s) {
  if (!s) return "Habilitado";
  const t = s.trim().toLowerCase();
  if (t.includes("inhabilit")) return "Inhabilitado";
  if (t.includes("suspend")) return "Suspendido";
  if (t.includes("baja")) return "Baja";
  return "Habilitado";
}

// ------------------------------------------------------------
// Upsert a Supabase via REST API
// ------------------------------------------------------------
async function upsertToSupabase(table, rows, conflictColumn) {
  if (rows.length === 0) return;
  const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumn}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase rechazo el upsert en '${table}': ${res.status} ${text}`);
  }
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  requireEnv();

  console.log("Logueando en Certronic...");
  const cookies = await login();

  console.log("Leyendo tabla de Vehiculos...");
  const rawVehiculos = await fetchAllRows(VEHICULOS_URL, cookies, "#ListaVehiculos");
  console.log(`  -> ${rawVehiculos.length} vehiculos encontrados`);
  const vehiculos = rawVehiculos
    .map(mapVehiculo)
    .filter((v) => v.dominio); // descarta filas vacias/basura

  console.log("Leyendo tabla de Personal...");
  const rawEmpleados = await fetchAllRows(EMPLEADOS_URL, cookies, "table");
  console.log(`  -> ${rawEmpleados.length} personas encontradas`);
  const personal = rawEmpleados
    .map(mapPersonal)
    .filter((p) => p.cuil);

  console.log("Subiendo a Supabase...");
  await upsertToSupabase("vehiculos", vehiculos, "dominio");
  await upsertToSupabase("personal", personal, "cuil");

  console.log("Listo. Vehiculos:", vehiculos.length, "| Personal:", personal.length);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
