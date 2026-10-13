import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gitExecFileAsync } from '../../src/main/git/runner'
import { test, expect } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { selectPairedRuntimeEnvironment } from './helpers/paired-client-runtime-environment'
import { waitForSessionReady } from './helpers/store'

test.use({ trace: 'off', minimumSeededWorktreeCount: 1 })

test('closing a restored local sibling reads its workspace owner while a paired host is selected', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const rootPath = await realpath(await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-restored-local-')))
  registerPostElectronShutdownCleanup(() => rm(rootPath, { recursive: true, force: true }))
  await gitExecFileAsync(['init'], { cwd: rootPath })
  await gitExecFileAsync(
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'Fixture'
    ],
    { cwd: rootPath }
  )
  const oldName = 'legacy-local.txt'
  const activeName = 'active-local.txt'
  const marker = 'RESTORED_LOCAL_OWNER_CONTENT'
  await writeFile(path.join(rootPath, oldName), marker)
  await writeFile(path.join(rootPath, activeName), 'ACTIVE_LOCAL_CONTENT')
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  let client = await launchPairedElectronClient(offer, testInfo, 'Fixture host')
  try {
    await selectPairedRuntimeEnvironment(orcaPage, {
      name: 'Fixture client',
      pairingUrl: (await createRuntimeDesktopPairingOffer(client.page)).pairingUrl,
      reusedProfile: false
    })
    const worktreeId = await client.page.evaluate(
      async ({ rootPath, files }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Paired store unavailable')
        }
        const repo = await store
          .getState()
          .addRepoPath(rootPath, 'git', { runtimeEnvironmentId: null })
        if (!repo) {
          throw new Error('Local fixture repo unavailable')
        }
        await store.getState().fetchWorktrees(repo.id, { executionHostId: 'local' })
        const worktree = store.getState().worktreesByRepo[repo.id]?.[0]
        if (!worktree) {
          throw new Error('Local fixture workspace unavailable')
        }
        store.getState().setActiveWorktree(worktree.id, 'local')
        for (const { name, filePath } of files) {
          store.getState().openFile(
            {
              filePath,
              relativePath: name,
              worktreeId: worktree.id,
              language: 'plaintext',
              mode: 'edit',
              runtimeEnvironmentId: null
            },
            { preview: false }
          )
        }
        return worktree.id
      },
      {
        rootPath,
        files: [oldName, activeName].map((name) => ({ name, filePath: path.join(rootPath, name) }))
      }
    )
    await client.page.evaluate((oldName) => {
      // Legacy saved files have no explicit runtime stamp; quit uses the real serializer.
      window.__store?.setState((state) => ({
        openFiles: state.openFiles.map((file) => {
          if (file.relativePath !== oldName) {
            return file
          }
          const { runtimeEnvironmentId: _owner, operationProvenance: _route, ...legacy } = file
          return legacy
        })
      }))
    }, oldName)
    await client.page.waitForTimeout(2_000)
    const userDataDir = client.userDataDir
    await client.quitPreservingProfile()
    client = await launchPairedElectronClient(offer, testInfo, 'Fixture host', {
      reuseUserDataDir: userDataDir
    })
    await client.page.evaluate(
      (worktreeId) => window.__store?.getState().setActiveWorktree(worktreeId, 'local'),
      worktreeId
    )
    const active = client.page.locator('[data-tab-id]').filter({ hasText: activeName }).first()
    await active.click()
    await client.page.screenshot({ path: testInfo.outputPath('before-close.png') })
    await active.locator('[data-tab-close-button]').click()
    await client.page.waitForTimeout(8_000)
    const error = client.page.getByText("The host couldn't find this file's workspace", {
      exact: false
    })
    const focusedHostReadCode = await client.page.evaluate(
      async ({ environmentId, worktreeId, relativePath }) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'files.read',
          params: { worktree: `id:${worktreeId}`, relativePath }
        })
        return response.ok ? 'ok' : response.error.code
      },
      { environmentId: client.environmentId, worktreeId, relativePath: oldName }
    )
    const record = {
      focusedHostReadCode,
      closedTabCount: await client.page
        .locator('[data-tab-id]')
        .filter({ hasText: activeName })
        .count(),
      hostUnresolvedAfterClose: (await error.count()) > 0,
      legacyRow: await client.page.evaluate(
        (oldName) =>
          window.__store
            ?.getState()
            .openFiles.filter((file) => file.relativePath === oldName)
            .map((file) => ({
              owner: file.runtimeEnvironmentId ?? null,
              hasOwner: file.runtimeEnvironmentId !== undefined,
              active: file.id === window.__store?.getState().activeFileId
            })),
        oldName
      )
    }
    await client.page.screenshot({ path: testInfo.outputPath('after-close.png') })
    const retry = client.page.getByRole('button', { name: 'Retry', exact: true })
    if (await retry.count()) {
      await retry.click()
      await client.page.waitForTimeout(8_000)
      await client.page.screenshot({ path: testInfo.outputPath('after-retry.png') })
    }
    await writeFile(
      testInfo.outputPath('restored-local-journey.json'),
      JSON.stringify(record, null, 2)
    )
    await expect(client.page.locator('[data-tab-id]').filter({ hasText: activeName })).toHaveCount(
      0
    )
    await expect(error).toHaveCount(0)
    await expect(client.page.locator('.monaco-editor').first()).toContainText(marker)
  } finally {
    await client.dispose()
  }
})
