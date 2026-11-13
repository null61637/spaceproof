# SpaceProof — Manifiesto v2 (especificación)

Estado: **definitiva**. Implementación de referencia: `backend/src/certificates/certificate-hash.ts`. Pruebas: `certificate-hash.spec.ts`.

Esta especificación alcanza para reimplementar el hash en cualquier lenguaje sin leer el código. Una vez anclado un certificado v2, **esta versión no se modifica**: cualquier cambio (un campo nuevo, otro orden, otra regla) es una versión 3.

## 1. Qué es

El manifiesto es un texto JSON que reúne el SHA-256 de un archivo y los metadatos declarados al certificarlo. Su SHA-256 es el **hash del certificado** (`contentHash`), y es **ese** hash —no el del archivo— el que se ancla en Avalanche.

```
bytes del archivo ──SHA-256──▶ file.sha256 ─┐
metadatos declarados ───────────────────────┼─▶ manifiesto canónico ──SHA-256──▶ contentHash ──▶ Avalanche
id y fecha del certificado ─────────────────┘
```

Cambiar un byte del archivo cambia `file.sha256`; cambiar cualquier metadato cambia el manifiesto. En ambos casos cambia `contentHash` y deja de coincidir con lo anclado.

El manifiesto prueba que estos metadatos quedaron ligados a este archivo. No prueba que los metadatos sean verdaderos, ni la procedencia del archivo, ni su autoría.

## 2. Campos

Exactamente estos, en este orden. No hay otros.

| # | Clave | Tipo JSON | Obligatorio | Contenido |
|---|---|---|---|---|
| 1 | `v` | número | sí | Siempre el entero `2` |
| 2 | `id` | texto | sí | Identificador del certificado: UUID en minúsculas con guiones, tal como lo generó el servidor |
| 3 | `createdAt` | texto | sí | Instante de emisión (regla de fechas) |
| 4 | `file` | objeto | sí | Dos claves, en este orden: |
| 4.1 | `file.sha256` | texto | sí | SHA-256 de los bytes del archivo, calculado por el servidor: 64 caracteres hexadecimales **en minúsculas** |
| 4.2 | `file.sizeBytes` | número | sí | Tamaño del archivo en bytes (regla de enteros) |
| 5 | `metadata` | objeto | sí | Seis claves, en este orden: |
| 5.1 | `metadata.title` | texto | sí | Título del certificado |
| 5.2 | `metadata.recipient` | texto | sí | A quién se emite |
| 5.3 | `metadata.satellite` | texto | sí | Satélite o misión declarados |
| 5.4 | `metadata.sensor` | texto o `null` | no | Sensor declarado |
| 5.5 | `metadata.sceneId` | texto o `null` | no | Identificador de escena o producto declarado |
| 5.6 | `metadata.acquiredAt` | texto | sí | Instante de adquisición declarado (regla de fechas) |

**Fuera del manifiesto, a propósito:** el nombre del archivo (renombrar el original no invalida el certificado), el estado del anclaje y la transacción, y cualquier coordenada.

## 3. Reglas de canonicalización

1. **Estructura.** Un único objeto JSON con las claves de la sección 2, en ese orden exacto. Ninguna clave se omite nunca.
2. **Sin espacios.** Ningún espacio, tabulación ni salto de línea entre elementos; nada antes de `{` ni después del `}` final (tampoco un salto de línea final ni BOM).
3. **Codificación.** El texto se codifica en UTF-8 antes de calcular el hash.
4. **Textos.**
   - Se normalizan a Unicode **NFC**.
   - Se usan tal como están guardados: la canonicalización no recorta espacios ni cambia mayúsculas. (La emisión recorta los extremos *antes* de guardar.)
   - Escape, igual que `JSON.stringify` de ECMAScript y que RFC 8785 §3.2.2.2: `"` → `\"`; `\` → `\\`; U+0008, U+0009, U+000A, U+000C, U+000D → `\b`, `\t`, `\n`, `\f`, `\r`; el resto de U+0000–U+001F → `\u00xx` con hexadecimales en minúsculas. **Todo lo demás va literal**, incluidos `/`, U+007F y todos los caracteres no ASCII (no se escriben como `\uXXXX`).
   - Deben ser Unicode bien formado (sin sustitutos sueltos).
5. **Opcionales.** `sensor` y `sceneId` ausentes se escriben como `null`. Un texto vacío `""` **no** equivale a `null` y produce otro hash; la emisión guarda `null`, nunca vacío.
6. **Fechas.** ISO 8601 en UTC, siempre con milisegundos y `Z`: `AAAA-MM-DDTHH:mm:ss.sssZ` (24 caracteres). Un instante con otro huso se convierte a UTC; la precisión mayor al milisegundo no existe (la base guarda milisegundos). Años entre 0001 y 9999.
7. **Enteros.** `v` y `file.sizeBytes` en decimal, sin signo, sin ceros a la izquierda, sin punto ni exponente. `sizeBytes` es un entero entre 1 y 2^53 − 1.
8. **Sin decimales.** El manifiesto v2 no contiene ningún número no entero.
9. **Hash.** `contentHash = SHA-256(bytes UTF-8 del manifiesto)`, expresado como 64 hexadecimales en minúsculas. En la blockchain se registra como `bytes32`: los mismos 32 bytes.

Un valor sin forma canónica (hash de archivo mal formado, tamaño no entero o menor que 1, fecha inválida) **no se hashea**: es un error.

## 4. Versiones

Cada certificado guarda su versión en `hashVersion`, y la verificación usa la función de esa versión.

| `hashVersion` | Qué cubre | Estado |
|---|---|---|
| 1 | `{"v":1,"id":…,"title":…,"recipient":…,"createdAt":…}` — solo metadatos, sin archivo | Congelada. Sigue verificándose igual; ya no se emite |
| 2 | Este documento | Vigente |

El primer campo del manifiesto (`v`) repite la versión, de modo que un manifiesto v1 y uno v2 nunca pueden producir el mismo texto. Una versión desconocida no se verifica: es un error, no un certificado inválido.

## 5. Vectores de prueba

Los hashes se calcularon fuera de la implementación (`sha256sum` sobre el texto exacto, sin salto de línea final). Cada manifiesto ocupa **una sola línea**.

### A — todos los campos

Datos: id `00000000-0000-4000-8000-000000000001`; emitido `2026-01-02T03:04:05.006Z`; archivo de 1 048 576 bytes con SHA-256 `e3b0…b855`; título «Escena de prueba»; destinatario «José Pérez»; satélite «Sentinel-2A»; sensor «MSI»; escena `S2A_MSIL2A_20260101T140051`; adquirido `2026-01-01T14:00:51.000Z`.

```json
{"v":2,"id":"00000000-0000-4000-8000-000000000001","createdAt":"2026-01-02T03:04:05.006Z","file":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","sizeBytes":1048576},"metadata":{"title":"Escena de prueba","recipient":"José Pérez","satellite":"Sentinel-2A","sensor":"MSI","sceneId":"S2A_MSIL2A_20260101T140051","acquiredAt":"2026-01-01T14:00:51.000Z"}}
```

`contentHash`: `268d7919b7a4f9abf52122595b8aecaa2caba5d8f13a3fca91f0d770fdc1f846` (382 bytes)

### B — opcionales ausentes

Igual que A, sin sensor ni escena.

```json
{"v":2,"id":"00000000-0000-4000-8000-000000000001","createdAt":"2026-01-02T03:04:05.006Z","file":{"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","sizeBytes":1048576},"metadata":{"title":"Escena de prueba","recipient":"José Pérez","satellite":"Sentinel-2A","sensor":null,"sceneId":null,"acquiredAt":"2026-01-01T14:00:51.000Z"}}
```

`contentHash`: `26b0b93f0283e50bc31efb639bfc96fdc233134a62b568c95b0d7b39247bc86b` (357 bytes)

### C — escapes y caracteres no ASCII

El título contiene comillas y una barra invertida: `Río "Paraná" \ banda 4`. El destinatario, `Ñandú S.A. 衛星`. Archivo de 209 715 200 bytes (200 MB).

```json
{"v":2,"id":"00000000-0000-4000-8000-000000000003","createdAt":"2026-12-31T23:59:59.999Z","file":{"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","sizeBytes":209715200},"metadata":{"title":"Río \"Paraná\" \\ banda 4","recipient":"Ñandú S.A. 衛星","satellite":"Landsat 9","sensor":"OLI-2","sceneId":null,"acquiredAt":"2026-06-15T13:45:00.000Z"}}
```

`contentHash`: `2317f60e2bde3bb7af2df6a8b6f71733a082405ae39f13f595831157165f96a2` (378 bytes)

### Equivalencias que una implementación debe respetar

Producen el **mismo** hash que A:

- «José Pérez» escrito en forma NFD (letra + acento combinante).
- La fecha de adquisición escrita como `2026-01-01T11:00:51-03:00`.
- Los mismos datos entregados en cualquier otro orden.

Producen un hash **distinto** de A: cambiar cualquiera de los once valores, incluido un solo milisegundo, un solo byte de tamaño o `sensor` vacío en lugar de `null`.

## 6. Verificar por cuenta propia

```sh
sha256sum archivo.tif                 # debe coincidir con file.sha256 del manifiesto
printf '%s' "$MANIFIESTO" | sha256sum # debe coincidir con el hash anclado en Avalanche
```

Atención: algunos intérpretes de comandos alteran las barras invertidas al pasar texto por `printf` o `echo`. Ante la duda, guardar el manifiesto en un archivo sin salto de línea final y ejecutar `sha256sum` sobre el archivo.
