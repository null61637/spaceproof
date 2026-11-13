# SpaceProof — API de emisión y verificación (F3)

Contrato de las rutas que emiten y verifican certificados de archivo. Implementación: `backend/src/certificates/`. El manifiesto y su hash están especificados en [manifiesto-v2.md](manifiesto-v2.md).

**Qué afirma esta API.** Que un archivo y sus metadatos coinciden, bit a bit, con lo que se certificó. No afirma la procedencia del archivo, la veracidad de los metadatos ni la autoría. Solo se comprueba la **firma TIFF** (4 bytes): no se valida que el archivo sea un TIFF íntegro, un GeoTIFF ni un COG.

**Estado del anclaje.** La integración con Avalanche no existe todavía (F5 y F6). Hasta entonces ninguna verificación devuelve `VALID`: el mejor resultado posible es `UNVERIFIABLE` con `reason: "ANCHOR_NOT_CONFIGURED"` y las comprobaciones de archivo y registro en `MATCH`.

## Reglas comunes

- Prefijo `/api`. El navegador usa el mismo origen (Next.js reenvía `/api/*`); no hay CORS.
- **Tipo de contenido de las escrituras** (protección CSRF): las dos rutas de archivo exigen `Content-Type: image/tiff`; cualquier otra escritura exige `application/json`. En otro caso, `415`. Ninguno de los dos tipos es «simple» para CORS, así que un sitio ajeno no puede enviarlos sin un preflight que la API nunca responde.
- El archivo viaja como **cuerpo crudo** (no multipart). Se procesa en flujo: cada bloque pasa por SHA-256 y se descarta. No se escribe en disco ni en la base, y no se acumula en memoria.
- Tamaño: entre 1 byte y **209 715 200 bytes (200 MB)**. Se comprueba con `Content-Length` cuando existe (antes de leer) y contando los bytes recibidos.
- Errores: JSON de NestJS `{ "statusCode", "message", "error" }`; `message` es un texto o, en errores de validación, una lista de textos. Los `500` y `503` devuelven `{ "statusCode", "message", "requestId" }`.
- Toda respuesta lleva `X-Request-Id`.
- Si el servidor responde antes de recibir el cuerpo completo (rechazo temprano), sigue leyendo y **descartando** lo que llega —sin calcular hash ni guardar nada— durante 5 segundos como máximo, y después cierra la conexión. Así el cliente alcanza a leer la respuesta en lugar de ver un corte, y un cuerpo sin fin no se lee indefinidamente. Conviene igual validar tamaño y campos antes de enviar: evita subir un archivo que va a ser rechazado.

## Intermediarios

El navegador habla solo con Next.js. `/api/*` llega al backend por el Route Handler `frontend/app/api/[...path]/route.ts`, que reenvía el cuerpo **en flujo**. No se usa `rewrites()` de Next: su proxy guarda una copia del cuerpo en memoria y lo corta a los 10 MB (medido: una subida de 11 MB falla). El `fetch` del Route Handler usa `redirect: "error"` y `window: null`; con cualquier otra combinación `fetch` retiene en memoria una segunda copia del cuerpo completo (medido: 199 MB retenidos para un archivo de 200 MB, frente a ~15 MB con esa configuración).

Caddy (`reverse_proxy`) reenvía el cuerpo en flujo por defecto; `encode` solo afecta a las respuestas.

## Objeto `Certificate`

```json
{
  "id": "5b0c…-uuid",
  "title": "Escena de prueba",
  "recipient": "José Pérez",
  "contentHash": "<64 hex: SHA-256 del manifiesto>",
  "txHash": null,
  "createdAt": "2026-11-13T12:00:00.000Z",
  "hashVersion": 2,
  "fileSha256": "<64 hex: SHA-256 del archivo>",
  "fileSizeBytes": 1048576,
  "fileName": "escena.tif",
  "satellite": "Sentinel-2A",
  "sensor": "MSI",
  "sceneId": null,
  "acquiredAt": "2026-01-01T14:00:51.000Z"
}
```

En un certificado v1 (`hashVersion: 1`, emitido antes de F3) todos los campos desde `fileSha256` son `null`. `txHash` no se usa: siempre es `null`.

## `POST /api/certificates` — emitir

Una sola solicitud: no hay carga previa ni identificador de archivo.

| Cabecera | Valor |
|---|---|
| `Content-Type` | `image/tiff` |
| `X-SpaceProof-Metadata` | base64url (RFC 4648 §5, con o sin `=`) del JSON de metadatos en UTF-8; hasta 8192 caracteres |
| `Content-Length` | Opcional. Si está, se usa para rechazar antes de leer |

Cuerpo: los bytes del archivo.

### Metadatos

| Campo | Obligatorio | Regla |
|---|---|---|
| `title` | sí | Texto, 1–200 caracteres |
| `recipient` | sí | Texto, 1–200 caracteres |
| `satellite` | sí | Texto, 1–200 caracteres |
| `acquiredAt` | sí | Instante ISO 8601 con segundos y zona: `2026-01-01T14:00:51Z`, `2026-01-01T11:00:51.000-03:00`. Años 0001–9999 |
| `sensor` | no | Texto, hasta 200 caracteres. Ausente, `null` o vacío se guarda como `null` |
| `sceneId` | no | Igual que `sensor` |
| `fileName` | sí | Texto, 1–255 caracteres, terminado en `.tif` o `.tiff`. Informativo: no forma parte del manifiesto |

Los textos se recortan en los extremos y se normalizan a Unicode NFC antes de validar y guardar. Se rechazan los caracteres de control, los de formato bidireccional y los sustitutos sueltos. Cualquier otra clave se rechaza: el cliente no puede enviar `id`, `createdAt`, hashes ni tamaño.

### Orden de las comprobaciones

1. `Content-Type` → `415`.
2. Cabecera de metadatos → `400`. **Antes de leer el cuerpo.**
3. `Content-Length`, si existe → `400` (cero o mal formado) o `413`. **Antes de leer el cuerpo.**
4. Cuerpo en flujo: firma TIFF en los primeros 4 bytes (`49 49 2A 00`, `4D 4D 00 2A`, `49 49 2B 00`, `4D 4D 00 2B`), SHA-256 y conteo de bytes.
5. Con el cuerpo completo: manifiesto v2, `contentHash` y **un único `INSERT`**. Una carga interrumpida o rechazada no deja ninguna fila.

### Respuestas

| Estado | Cuándo |
|---|---|
| `201` | Certificado emitido. Cuerpo: `Certificate` |
| `400` | Metadatos ausentes, mal codificados o inválidos; archivo vacío; `Content-Length` mal formado; carga interrumpida |
| `408` | La solicitud completa tardó más de 5 minutos (límite por defecto de Node, `requestTimeout`). Sin cuerpo JSON. Medido: una subida de 240 s termina bien; una de 340 s se corta a los ~326 s. No queda ningún registro |
| `413` | Más de 200 MB (por `Content-Length` o por bytes recibidos) |
| `415` | `Content-Type` distinto de `image/tiff`, o el archivo no tiene firma TIFF |
| `500` / `503` | Error interno / base de datos no disponible. No queda ningún registro |

Reintentar una emisión cuya respuesta se perdió crea un segundo certificado del mismo archivo (cada uno con su `id`).

## `POST /api/certificates/:id/verify-file` — verificar un archivo

Cabecera `Content-Type: image/tiff`; cuerpo: los bytes del archivo que se quiere comprobar. Sin cabecera de metadatos. Mismo límite de tamaño. **No se exige la firma TIFF**: un archivo alterado en sus primeros bytes debe dar `FILE_MISMATCH`, no un rechazo.

El certificado se busca **antes** de leer el cuerpo.

| Estado | Cuándo |
|---|---|
| `200` | Verificación realizada. Cuerpo: `Verification`. Un archivo alterado también es `200`, con `status: "INVALID"` |
| `400` | `id` que no es un UUID; archivo vacío; `Content-Length` mal formado; carga interrumpida |
| `404` | No existe el certificado |
| `409` | Certificado v1: no tiene archivo asociado. Usar `GET …/verify` |
| `408` / `413` / `415` | Como en la emisión (el `415` solo por `Content-Type`) |

## `GET /api/certificates/:id/verify` — verificar el registro

Sin archivo: recalcula el manifiesto desde la base y consulta el anclaje. Sirve para v1 y v2. Devuelve `Verification` con `checks.file: "NOT_CHECKED"` y `file: null`, más el campo heredado `valid`.

`valid` (**obsoleto**, se conserva por compatibilidad) equivale a `checks.record == "MATCH"`. No dice nada del archivo ni de la blockchain: usar `status`.

## Objeto `Verification`

```json
{
  "status": "UNVERIFIABLE",
  "reason": "ANCHOR_NOT_CONFIGURED",
  "checks": { "file": "MATCH", "record": "MATCH", "anchor": "NOT_CONFIGURED" },
  "hashVersion": 2,
  "storedHash": "<contentHash guardado>",
  "computedHash": "<hash del manifiesto recalculado>",
  "file": {
    "storedSha256": "<SHA-256 certificado>",
    "receivedSha256": "<SHA-256 del archivo recibido>",
    "receivedSizeBytes": 1048576
  },
  "anchoredAt": null,
  "anchor": null
}
```

`anchor` es el registro de anclaje que SpaceProof guarda para el certificado, o `null` si no tiene (certificados emitidos sin contrato configurado):

```json
{ "status": "CONFIRMED", "txHash": "0x…", "chainId": 43113, "contractAddress": "0x…" }
```

`status` es `PENDING`, `SUBMITTED`, `CONFIRMED` o `FAILED`; `txHash` puede ser `null`. Es informativo (estado del envío, transacción para buscar en un explorador): **nunca es lo que hace `VALID` un resultado**; eso lo decide la cadena, consultada en cada verificación.

### Comprobaciones

| `checks.` | Valores | Significado |
|---|---|---|
| `file` | `MATCH`, `MISMATCH`, `NOT_CHECKED` | SHA-256 del archivo recibido frente al certificado |
| `record` | `MATCH`, `MISMATCH` | Manifiesto recalculado desde la base frente a `contentHash` |
| `anchor` | `ANCHORED`, `NOT_ANCHORED`, `NOT_CONFIGURED`, `UNAVAILABLE`, `NOT_CHECKED` | Consulta en vivo del anclaje de `contentHash`. `NOT_CHECKED` cuando una comprobación anterior ya falló |

### Resultado

Se evalúa en este orden; gana la primera fila que aplica.

| `status` | `reason` | Cuándo | Qué decirle al usuario |
|---|---|---|---|
| `INVALID` | `FILE_MISMATCH` | `file = MISMATCH` | El archivo no es el certificado: fue modificado o es otro |
| `INVALID` | `RECORD_MISMATCH` | `record = MISMATCH` | Los datos del certificado fueron alterados |
| `UNVERIFIABLE` | `ANCHOR_TARGET_MISMATCH` | El registro `anchor` nombra otro contrato u otra cadena que los configurados | Coincide con el registro de SpaceProof; **no** se pudo comprobar en Avalanche |
| `INVALID` | `ANCHOR_RECORD_MISMATCH` | El hash está en la cadena, pero el registro `anchor` figura `CONFIRMED` con una fecha o una transacción que la cadena no respalda (revirtió, no existe, es de otro contrato o de otro hash) | El registro de anclaje de SpaceProof no coincide con la blockchain |
| `VALID` | `null` | `anchor = ANCHORED` y, si hay registro `CONFIRMED`, coincide con la cadena | Coincide con lo certificado y con el registro en Avalanche (`anchoredAt`) |
| `INVALID` | `NOT_ANCHORED` | La cadena respondió que el hash no está, y el registro `anchor` figura `CONFIRMED` | El registro no coincide con la blockchain |
| `PENDING` | `NOT_ANCHORED` | La cadena respondió y el hash no está (sin registro, o registro sin confirmar) | Coincide; todavía no está registrado en Avalanche |
| `UNVERIFIABLE` | `ANCHOR_NOT_CONFIGURED` | No hay integración con Avalanche | Coincide con el registro de SpaceProof; **no** se pudo comprobar en Avalanche: integración pendiente |
| `UNVERIFIABLE` | `ANCHOR_UNAVAILABLE` | La consulta a la cadena falló (RPC) | Coincide con el registro de SpaceProof; **no** se pudo comprobar en Avalanche: reintentar |

Reglas que la implementación garantiza:

- `VALID` exige una respuesta positiva de la cadena, obtenida en esa misma verificación. Ni un error de RPC, ni la falta de integración, ni el registro `anchor` de la base producen `VALID`.
- La verificación solo lee: nunca corrige el registro `anchor`.
- Con `ANCHOR_RECORD_MISMATCH`, `checks.anchor` es `ANCHORED` (el hash está en la cadena): lo inconsistente es el registro de SpaceProof.
- `VALID` en `GET …/verify` no cubre el archivo (`checks.file` es `NOT_CHECKED`).
- `UNVERIFIABLE` no significa «alterado»: las comprobaciones de archivo y registro pasaron, y lo dice `checks`.
- Un certificado con una versión de hash desconocida no se puede verificar: `500`, no `INVALID`.

## `GET /api/certificates/:id/manifest`

Devuelve el texto canónico exacto cuyo SHA-256 es `contentHash`, reconstruido desde la base (`Content-Type: application/json; charset=utf-8`, sin salto de línea final). Permite que un tercero lo re-hashee por su cuenta. Para v1 devuelve la forma canónica v1. `400` / `404` como el resto.

## Sin cambios

`GET /api/certificates` (lista, más recientes primero) y `GET /api/certificates/:id`.

## Cambio incompatible respecto de la versión anterior

`POST /api/certificates` con cuerpo JSON (`title`, `recipient`) ya no existe: responde `415`. No se pueden emitir certificados sin archivo. Los certificados v1 existentes se siguen listando, consultando y verificando.

## Anclaje

- La verificación lee en vivo el contrato `SpaceProofAnchor` de Avalanche Fuji cuando están configuradas `ANCHOR_RPC_URL` y `ANCHOR_CONTRACT_ADDRESS`. Sin ellas, responde `ANCHOR_NOT_CONFIGURED`.
- Con esas dos variables, cada certificado se emite junto con su registro `anchor` en `PENDING`. `POST /api/certificates` no cambia: responde el certificado, sin el registro.
- Con `ANCHOR_PRIVATE_KEY` además, el backend envía el anclaje por su cuenta después de responder la emisión, y lo confirma leyendo la cadena. El estado se ve en `anchor.status` de la verificación. Probado solo contra una cadena simulada (ver [ESTADO_Y_PENDIENTES.md](ESTADO_Y_PENDIENTES.md), sección 11.10).
- En la cadena solo se registra el hash del certificado (`contentHash`): ni el archivo ni los metadatos.
