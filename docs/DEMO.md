# SpaceProof — guion de la demo (2 minutos)

Lo que se muestra: certificar un archivo, ver su huella anclada en Avalanche, verificar el original y ver fallar la verificación de una copia con **un solo bit** cambiado.

> **Estado de este guion.** Los pasos 1, 2, 4 y 5 se pueden ejecutar hoy. El paso 3 (el anclaje llegando solo a `CONFIRMED`, con su transacción en Snowtrace) depende de la **prueba real en Fuji, que todavía no se hizo** y requiere autorización: hasta entonces el anclaje queda `PENDING` y la verificación responde «todavía no registrado», nunca «válido». No presentar la cadena simulada de las pruebas como transacciones reales.

## Preparación (antes de presentar)

1. **Archivos de la demo**, siempre idénticos:

   ```bash
   node scripts/demo-files.mjs
   ```

   | Archivo | SHA-256 |
   |---|---|
   | `demo/escena-demo.tif` (262 266 bytes) | `48d4642b97c94355802c06e66db927a602abe222a3d6f457ecbda5dd2bc57bdb` |
   | `demo/escena-demo-alterada.tif` (un bit distinto, en el byte 131 450) | `c6e8e6c98140f04d882a1fe1c36eb0028c131045aa486b58f86f1180d3aca763` |

   Es una escena **sintética** (un TIFF válido de 512×512 generado por el script), no un producto satelital real. Decirlo en la demo.

2. **Base de datos** con todas las migraciones aplicadas, incluida `Anchor` (`pnpm exec prisma migrate deploy` en `backend/`).
3. **`backend/.env`** con `ANCHOR_RPC_URL` y `ANCHOR_CONTRACT_ADDRESS` (lectura). Para el paso 3 real, además `ANCHOR_PRIVATE_KEY` con la clave del owner, y saldo de prueba en esa cuenta (~45 700 gas por anclaje).
4. `npm run dev` y abrir <http://localhost:3000>. Comprobar en el log del backend «Anchor signer ready».
5. Tener abierta en otra pestaña la página del contrato: <https://testnet.snowtrace.io/address/0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF>.
6. Ensayar una vez completo: cada ensayo con clave gasta una transacción de prueba.

Metadatos para escribir en el formulario (declarados, de ejemplo):

| Campo | Valor |
|---|---|
| Título | Escena demo — delta del Paraná |
| Destinatario | Jurado de la hackathon |
| Satélite | Sentinel-2A |
| Fecha y hora de adquisición (UTC) | 2026-11-01 14:00:51 |
| Sensor | MSI |

## Guion

| Tiempo | Qué se hace | Qué se dice |
|---|---|---|
| 0:00 | Pantalla inicial | «Una imagen satelital pasa por muchas manos. SpaceProof prueba que el archivo y sus datos no cambiaron desde que se certificaron.» |
| 0:15 | **1. Subir** `escena-demo.tif`, completar los metadatos, «Certificar archivo» | «El servidor calcula el SHA-256 del archivo. No lo guarda: solo su huella.» |
| 0:35 | **2. Certificado**: mostrar el SHA-256 del archivo, el hash del manifiesto y el ID | «El manifiesto une el archivo con sus metadatos. Su hash es lo único que va a la blockchain.» |
| 0:50 | **3. Anclaje**: el panel pasa de `PENDING` a `SUBMITTED` y a `CONFIRMED`; clic en la transacción → Snowtrace | «Esto es un contrato público en Avalanche. Ni nosotros podemos borrar o cambiar este registro.» |
| 1:15 | **4. Verificar el original**: subir otra vez `escena-demo.tif` → **VÁLIDO** | «Recalcula todo y consulta el contrato en vivo. Coincide bit a bit.» |
| 1:35 | **5. Verificar la copia alterada**: subir `escena-demo-alterada.tif` → **INVÁLIDO** | «Esta copia tiene un solo bit distinto, invisible a simple vista. La verificación falla.» |
| 1:50 | Cierre, con el pie de página a la vista | «Prueba integridad, no procedencia ni autoría. Y si no puede consultar la blockchain dice "no verificable": nunca inventa un "válido".» |

## Si algo falla en vivo

| Síntoma | Qué pasa | Qué hacer |
|---|---|---|
| El panel queda en `PENDING` | No hay clave configurada, o el backend no pudo comprobar la cuenta | Mirar el log del backend. Sin clave, el anclaje no se envía |
| «No verificable: Avalanche no respondió» | El RPC público no contestó | «Actualizar». Es el comportamiento correcto: no inventa un resultado |
| El panel queda en `SUBMITTED` | La transacción está en camino | Esperar unos segundos; se actualiza solo |
| `FAILED` | Cinco intentos sin éxito | Revisar saldo y log. No mostrar como éxito |

Plan B sin transacciones: mostrar los pasos 1, 2, 4 y 5 con el anclaje en `PENDING` (la verificación del original dice «coincide, pero todavía no está registrado en Avalanche»; la de la copia alterada dice **INVÁLIDO** igual), y mostrar en Snowtrace los dos anclajes de prueba reales ya existentes en el contrato (sección 10 de [ESTADO_Y_PENDIENTES.md](ESTADO_Y_PENDIENTES.md)), aclarando que se anclaron a mano.

## Pendiente antes de presentar

- [ ] Prueba real controlada en Fuji (requiere autorización): un certificado llega solo a `CONFIRMED`.
- [ ] Capturas o grabación de los pasos 3 y 4 con una transacción real.
- [ ] Ensayo cronometrado, dos veces seguidas.
