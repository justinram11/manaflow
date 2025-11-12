import { createClient } from '@hey-api/openapi-ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OPENAPI_SPEC_URL = 'https://cloud.morph.so/api/openapi.json'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.join(__dirname, '..')
const outputPath = path.join(packageRoot, 'src/client')
const tsConfigPath = path.join(packageRoot, 'tsconfig.json')

await fs.promises.mkdir(outputPath, { recursive: true })

console.time('morphcloud:download-openapi')
const response = await fetch(OPENAPI_SPEC_URL)
if (!response.ok) {
  throw new Error(
    `Failed to download MorphCloud OpenAPI spec (${response.status} ${response.statusText})`
  )
}
const specBody = await response.text()
console.timeEnd('morphcloud:download-openapi')

const tmpFile = path.join(
  os.tmpdir(),
  `morphcloud-openapi-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.json`
)

await fs.promises.writeFile(tmpFile, specBody)

try {
  console.time('morphcloud:generate-client')
  await createClient({
    input: tmpFile,
    output: {
      path: outputPath,
      tsConfigPath,
    },
    plugins: ['@hey-api/client-fetch', '@hey-api/typescript'],
  })
  console.timeEnd('morphcloud:generate-client')
} finally {
  await fs.promises.rm(tmpFile, { force: true })
}

console.log('[morphcloud] OpenAPI client generated at', outputPath)
