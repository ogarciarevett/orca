import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForSessionReady } from './helpers/store'
import { waitForPairedClientWorktree } from './helpers/paired-client-host-session'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { selectPairedRuntimeEnvironment } from './helpers/paired-client-runtime-environment'
import type { Page } from '@stablyai/playwright-test'

test.use({ trace: 'off', minimumSeededWorktreeCount: 1 })

async function observe(page: Page, relativePath: string) {
  return page.evaluate((relativePath) => {
    const state = window.__store?.getState()
    return {
      rows: state?.openFiles
        .filter((file) => file.relativePath === relativePath)
        .map((file) => ({
          id: file.id,
          owner: file.runtimeEnvironmentId ?? null,
          mirrored: file.mirroredFromRuntimeSession === true,
          active: file.id === state.activeFileId
        })),
      error: document.body.innerText.includes("The host couldn't find this file's workspace"),
      retry: [...document.querySelectorAll('button')].some((button) => button.innerText === 'Retry')
    }
  }, relativePath)
}

test('reciprocal client file open close reopen and Retry preserve the execution host', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = 'paired-load-fixture.txt'
  const marker = 'PAIRED_EDITOR_FIXTURE_CONTENT'
  const filePath = path.join(context.rootPath, relativePath)
  await writeFile(filePath, marker, 'utf8')
  const hostOffer = await createRuntimeDesktopPairingOffer(orcaPage)
  let client = await launchPairedElectronClient(hostOffer, testInfo, 'Isolated fixture host')
  const observations: Record<string, unknown> = {}
  const save = async () => {
    await writeFile(testInfo.outputPath('journey.json'), JSON.stringify(observations, null, 2))
  }
  const capture = async (stage: string) => {
    observations[stage] = {
      host: await observe(orcaPage, relativePath),
      client: await observe(client.page, relativePath)
    }
    await client.page.screenshot({ path: testInfo.outputPath(`${stage}.png`) })
    await save()
  }
  try {
    await waitForPairedClientWorktree(client.page, context.worktreeId)
    await selectPairedRuntimeEnvironment(orcaPage, {
      name: 'Isolated fixture client',
      pairingUrl: (await createRuntimeDesktopPairingOffer(client.page)).pairingUrl,
      reusedProfile: false
    })
    const hostData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const port = async (page: Page) =>
      page.evaluate(async () => {
        const result = await window.api.mobile.isWebSocketReady()
        return result.endpoint ? new URL(result.endpoint).port : null
      })
    observations.isolation = {
      distinctProfiles: hostData !== client.userDataDir,
      background: true,
      hostPort: await port(orcaPage),
      clientPort: await port(client.page)
    }
    if (process.env.ORCA_E2E_EDITOR_HOST_ORIGIN === '1') {
      await orcaPage.evaluate(
        ({ context, filePath, relativePath }) => {
          window.__store?.getState().openFile(
            {
              worktreeId: context.worktreeId,
              filePath,
              relativePath,
              language: 'plaintext',
              mode: 'edit',
              runtimeEnvironmentId: null
            },
            { preview: false }
          )
        },
        { context, filePath, relativePath }
      )
    }
    const open = async () => {
      await client.page.evaluate(
        ({ context, filePath, relativePath, environmentId }) => {
          const store = window.__store
          if (!store) {
            throw new Error('Paired store unavailable')
          }
          store.getState().setActiveWorktree(context.worktreeId, `runtime:${environmentId}`)
          store.getState().openFile(
            {
              worktreeId: context.worktreeId,
              filePath,
              relativePath,
              language: 'plaintext',
              mode: 'edit',
              runtimeEnvironmentId: environmentId
            },
            { preview: false }
          )
        },
        { context, filePath, relativePath, environmentId: client.environmentId }
      )
      await client.page.locator('[data-tab-id]').filter({ hasText: relativePath }).first().click()
    }
    await open()
    await client.page.waitForTimeout(8_000)
    await capture('opened')
    if (process.env.ORCA_E2E_EDITOR_RESTART_CLIENT === '1') {
      const userDataDir = client.userDataDir
      await client.quitPreservingProfile()
      client = await launchPairedElectronClient(hostOffer, testInfo, 'Isolated fixture host', {
        reuseUserDataDir: userDataDir
      })
      await waitForPairedClientWorktree(client.page, context.worktreeId)
      await client.page.evaluate(
        ({ worktreeId, environmentId }) => {
          window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
        },
        { worktreeId: context.worktreeId, environmentId: client.environmentId }
      )
      await client.page.waitForTimeout(8_000)
      await capture('restored')
    }
    await client.page
      .locator('[data-tab-id]')
      .filter({ hasText: relativePath })
      .first()
      .locator('[data-tab-close-button]')
      .click()
    await client.page.waitForTimeout(8_000)
    await capture('closed')
    await expect(
      client.page.locator('[data-tab-id]').filter({ hasText: relativePath })
    ).toHaveCount(0)
    await open()
    await client.page.waitForTimeout(8_000)
    await capture('reopened')
    const retry = client.page.getByRole('button', { name: 'Retry', exact: true })
    if (await retry.count()) {
      await retry.click()
      await client.page.waitForTimeout(8_000)
      await capture('retried')
    } else {
      observations.retry = 'No error view or Retry button after successful reopen'
      await save()
    }
    await expect(
      client.page.getByText("The host couldn't find this file's workspace", { exact: false })
    ).toHaveCount(0)
    await expect(client.page.locator('.monaco-editor').first()).toContainText(marker)
  } finally {
    await save()
    await client.dispose()
  }
})
