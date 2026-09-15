name: Sync Certronic -> Supabase

on:
  schedule:
    # 08:00 Argentina (UTC-3) = 11:00 UTC. Ajustar si hace falta.
    - cron: "0 11 * * *"
  workflow_dispatch: {} # permite correrlo a mano desde la pestaña Actions

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Instalar dependencias
        run: npm install

      - name: Correr sincronizacion
        env:
          CERTRONIC_USER: ${{ secrets.CERTRONIC_USER }}
          CERTRONIC_PASS: ${{ secrets.CERTRONIC_PASS }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        run: npm run sync
