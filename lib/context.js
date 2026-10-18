/**
 * Per-model context overrides.
 *
 * The provider route is rebuilt from the live catalog on every sync, so a
 * `contextWindow` edited by hand would be lost. These overrides are layered on
 * top of the catalog when the profile is written, and outlive both the sync and
 * a restart. They are deliberately not part of the plugin's settings: the
 * settings section is composition config, while this is a per-machine choice
 * made from the settings page.
 * @module dsh-ollama-cloud/context
 */
import { readFile, rename, writeFile } from 'node:fs/promises'

const VERSION = 1

/**
 * Open the override store, creating nothing until the first write.
 * A missing or unreadable file starts with no overrides.
 * @param {{path: string}} options
 * @returns {Promise<{
 *   all: () => Record<string, number>,
 *   get: (id: string) => number|undefined,
 *   set: (id: string, value: number) => Promise<void>,
 *   delete: (id: string) => Promise<void>,
 * }>}
 */
export async function openContextOverrides({ path }) {
  /** @type {Map<string, number>} */
  const overrides = new Map()
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed?.version === VERSION && parsed.overrides !== null && typeof parsed.overrides === 'object' && !Array.isArray(parsed.overrides)) {
      for (const [id, value] of Object.entries(parsed.overrides)) {
        if (typeof id === 'string' && id.length > 0 && Number.isInteger(value) && value > 0) overrides.set(id, value)
      }
    }
  } catch {
    // absent or corrupt: no overrides
  }

  const persist = async () => {
    const body = JSON.stringify({ version: VERSION, overrides: Object.fromEntries(overrides) })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, body, { mode: 0o600 })
    await rename(temp, path)
  }

  return {
    all: () => Object.fromEntries(overrides),
    get: (id) => overrides.get(id),
    async set(id, value) {
      overrides.set(id, value)
      await persist()
    },
    async delete(id) {
      overrides.delete(id)
      await persist()
    },
  }
}
