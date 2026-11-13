# SpaceProof — contrato de anclaje

Paquete aislado (Hardhat 3, viem) con el contrato `SpaceProofAnchor` para Avalanche Fuji (C-Chain de pruebas, chain ID 43113). Tiene su propio `package.json` y lockfile: no comparte dependencias con `backend/` ni `frontend/`.

## Qué hace el contrato

Un registro público de hashes de certificados, de solo agregado.

| Elemento | Comportamiento |
|---|---|
| `owner` | La cuenta que desplegó el contrato (la billetera del backend). Inmutable: no se puede transferir |
| `anchor(bytes32 hash)` | Registra el hash con la marca de tiempo del bloque. Solo el owner. Rechaza el hash cero y los duplicados |
| `anchoredAt(bytes32 hash)` | Consulta pública: segundos Unix del anclaje, o `0` si nunca se ancló |
| `Anchored(hash, timestamp)` | Evento emitido una vez por hash |
| Errores | `NotOwner()`, `EmptyHash()`, `AlreadyAnchored(hash, anchoredAt)` |

El hash es el `contentHash` del certificado —el SHA-256 de su manifiesto canónico ([docs/manifiesto-v2.md](../docs/manifiesto-v2.md))— como los mismos 32 bytes. En la cadena solo hay hashes: ni archivos, ni metadatos, ni datos personales.

Que un hash esté en el contrato significa que la clave de SpaceProof lo registró en esa fecha. No dice nada sobre la procedencia del archivo, la veracidad de los metadatos ni la autoría.

No hay proxy ni actualización, ni forma de borrar o reemplazar una entrada.

## Uso

Requiere Node.js 22.13 o posterior.

```bash
npm ci
npm run build       # compila y actualiza abi/SpaceProofAnchor.json
npm run typecheck
npm test            # red local de Hardhat; no necesita clave ni red
```

## Despliegue en Fuji

1. Crear una clave **solo para Fuji** (sin fondos reales) y cargarle AVAX de prueba desde un faucet de Fuji.
2. Copiar `.env.example` a `.env` y completar `ANCHOR_PRIVATE_KEY`. `.env` no se versiona.
3. Desplegar y comprobar:

```bash
npm run deploy:fuji   # escribe deployments/fuji.json
npm run check:fuji    # relee la cadena y la compara con ese archivo
```

El script se niega a desplegar si la cadena no es la 43113, si la cuenta no tiene saldo o si ya existe `deployments/fuji.json`. No hay red de mainnet configurada.

Verificación del código fuente en un explorador (Sourcify no pide clave de API):

```bash
npx hardhat verify sourcify --network fuji <dirección>
```

## Qué se versiona

| Archivo | Para qué |
|---|---|
| `abi/SpaceProofAnchor.json` | ABI que usará el backend. Una prueba falla si difiere del contrato compilado |
| `deployments/fuji.json` | Dirección, owner, transacción y bloque del despliegue. Solo datos públicos. Contrato desplegado en Fuji: `0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF` ([explorador](https://testnet.snowtrace.io/address/0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF), [código verificado en Sourcify](https://sourcify.dev/server/repo-ui/43113/0xb5cA7811682676e0B7a8fc568B28dbf6f841c8CF)) |

La cuenta que despliega es el owner, así que el backend debe firmar los anclajes con esa misma clave (`ANCHOR_PRIVATE_KEY`).
