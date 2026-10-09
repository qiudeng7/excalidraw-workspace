import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { api, ApiError } from '../../src/lib/api'
import { useCanvasDocument } from '../../src/composables/useCanvasDocument'
import { useWorkspaceNavigation } from '../../src/composables/useWorkspaceNavigation'
import { useWorkspaceDirectory, type WorkspaceDirectoryDependencies } from '../../src/composables/useWorkspaceDirectory'
import { useOperation } from '../../src/composables/useOperation'
import type { CanvasDocument, CanvasMeta, Workspace } from '../../shared/contracts'

const canvas = (id: string, position: number): CanvasDocument => ({ id, position, workspaceId: 'space', name: id, revision: 0, createdAt: '', updatedAt: '', scene: { elements: [], appState: {}, files: {} } })
const workspace: Workspace = { id: 'space', name: 'space', catalogRevision: 0, createdAt: '', updatedAt: '' }

test('HTTP port refuses successful HTML/null responses instead of returning a forged DTO', async () => {
  const original = globalThis.fetch
  try {
    for (const body of ['<html>error</html>', 'null']) {
      globalThis.fetch = (async () => new Response(body)) as typeof fetch
      await assert.rejects(api('/api/bootstrap'), { code: 'INVALID_RESPONSE' })
    }
  } finally { globalThis.fetch = original }
})

test('document controller commits scene and library together and captures the owner', async () => {
  let failLibrary = false
  let loaded = 0
  const owners: string[] = []
  const document = useCanvasDocument({
    api: { readCanvas: async id => canvas(id, 0), readLibrary: async owner => { owners.push(owner); if (failLibrary) throw new Error('offline'); return { items: [owner], revision: 1 } } },
    ownerId: () => 'alice', onLoaded: () => { loaded++ },
  })
  await document.loadCanvas('original')
  failLibrary = true
  await assert.rejects(document.loadCanvas('replacement'), /offline/)
  assert.equal(document.document.value?.id, 'original')
  assert.deepEqual(document.library.value?.items, ['alice'])
  assert.equal(loaded, 1)
  assert.deepEqual(owners, ['alice', 'alice'])
})

test('navigation conflict adopts the winning revision without retrying or selecting another canvas', async () => {
  let writes = 0
  let reads = 0
  const navigation = useWorkspaceNavigation({
    readNavigation: async () => ({ revision: ++reads, lastWorkspaceId: 'space', lastCanvasId: 'other', workspaces: [] }),
    recordOpened: async () => { writes++; throw new ApiError(409, 'NAVIGATION_CONFLICT', 'conflict') },
  })
  await navigation.recordOpened('current')
  assert.equal(writes, 1)
  assert.equal(navigation.navigation.value?.revision, 2)
  assert.match(navigation.navigationNotice.value, /当前画布已打开/)
})

function directoryFixture() {
  let catalog: CanvasMeta[] = [canvas('first', 0), canvas('second', 1)]
  let catalogFails = false
  let flushFails = false
  const operation = useOperation(() => false)
  const document = useCanvasDocument({ api: { readCanvas: async id => canvas(id, 0), readLibrary: async () => ({ items: [], revision: 0 }) }, ownerId: () => 'alice', onLoaded() {} })
  const navigation = useWorkspaceNavigation({ readNavigation: async () => ({ revision: 0, lastWorkspaceId: null, lastCanvasId: null, workspaces: [] }), recordOpened: async canvasId => ({ revision: 1, lastWorkspaceId: 'space', lastCanvasId: canvasId, workspaces: [] }) })
  const unused = async (): Promise<never> => { throw new Error('Unexpected API action') }
  const api: WorkspaceDirectoryDependencies['api'] = {
    listWorkspaces: async () => [workspace],
    readCatalog: async () => { if (catalogFails) throw new Error('catalog unavailable'); return { canvases: catalog, catalogRevision: 0 } },
    reorder: async () => { throw new ApiError(409, 'CATALOG_CONFLICT', 'conflict') },
    createWorkspace: unused, renameWorkspace: unused, deleteWorkspace: unused,
    createCanvas: unused, renameCanvas: unused, deleteCanvas: unused,
  }
  const directory = useWorkspaceDirectory({ api, navigationController: navigation, canvasDocument: document,
    editor: { flush: async () => { if (flushFails) throw new Error('unsaved scene') } },
    interactionLocked: operation.busy, run: operation.run,
    dialogs: { prompt: async () => null, confirm: async () => false },
  })
  return { directory, document, operation, failCatalog: () => { catalogFails = true }, failFlush: () => { flushFails = true }, remoteOrder: (ids: string[]) => { catalog = ids.map(id => catalog.find(item => item.id === id)!) } }
}

test('directory refuses switching past a failed editor save barrier', async () => {
  const { directory, document, operation, failFlush } = directoryFixture()
  await directory.loadWorkspaces()
  failFlush()
  await directory.selectCanvas('second')
  assert.equal(document.document.value?.id, 'first')
  assert.equal(operation.error.value, 'unsaved scene')
})

test('catalog conflict restores server order without replacing the loaded editor; failed reconciliation locks mutations', async () => {
  const { directory, document, operation, failCatalog } = directoryFixture()
  await directory.loadWorkspaces()
  await directory.reorderCanvas(['second', 'first'])
  assert.deepEqual(directory.canvases.value.map(item => item.id), ['first', 'second'])
  assert.equal(document.document.value?.id, 'first')
  assert.match(operation.error.value, /其他页面更新/)
  failCatalog()
  await directory.reorderCanvas(['second', 'first'])
  assert.equal(directory.directoryStale.value, true)
  assert.equal(directory.directoryLocked.value, true)
  assert.deepEqual(directory.canvases.value.map(item => item.id), ['first', 'second'])
})
