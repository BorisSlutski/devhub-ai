import { test, expect } from '@playwright/test'
import { launchApp } from './electron-helpers'

test.describe('Environment Safety & UX', () => {
  test('all main tabs are navigable without error', async () => {
    const { app, page } = await launchApp()
    const tabs = ['Launchpad', 'All Folders', 'Claude', 'Agents']
    for (const tabName of tabs) {
      await page.locator('.tab', { hasText: tabName }).click()
      await page.waitForTimeout(200)
      await expect(page).toHaveTitle(/DevHub-AI/)
      const title = await page.title()
      expect(title).toContain('DevHub-AI')
    }
    await app.close()
  })

  test('rapid tab switching does not crash', async () => {
    const { app, page } = await launchApp()
    for (let i = 0; i < 10; i++) {
      await page.locator('.tab', { hasText: 'Claude' }).click()
      await page.locator('.tab', { hasText: 'Launchpad' }).click()
    }
    await expect(page.locator('.tabs-bar')).toBeVisible()
    await expect(page).toHaveTitle(/DevHub-AI/)
    const title = await page.title()
    expect(title).toContain('DevHub-AI')
    await app.close()
  })

  test('All Folders tab renders folder view', async () => {
    const { app, page } = await launchApp()
    await page.locator('.tab', { hasText: 'All Folders' }).click()
    await expect(page.locator('.folders-view')).toBeVisible()
    await app.close()
  })

  test('Claude empty state has clear guidance text', async () => {
    const { app, page } = await launchApp()
    await page.locator('.tab', { hasText: 'Claude' }).click()
    await expect(page.locator('.claude-sessions-empty')).toContainText(/Click "Claude" on any folder/)
    await expect(page.getByRole('button', { name: 'New Claude Session' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'New Claude Session' })).toBeEnabled()
    await app.close()
  })

  test('keyboard shortcut help dialog opens and closes', async () => {
    const { app, page } = await launchApp()
    await page.locator('.titlebar-shortcut-hint').click()
    const shortcutsModal = page.locator('.shortcuts-modal, .modal')
    await expect(shortcutsModal).toBeVisible()
    await expect(shortcutsModal).toContainText('Terminal')
    await page.keyboard.press('Escape')
    await expect(shortcutsModal).not.toBeVisible()
    await app.close()
  })

  test('theme can be switched without breaking layout', async () => {
    const { app, page } = await launchApp()
    const themeSwitcher = page.locator('.theme-switcher')
    await themeSwitcher.locator('button').nth(0).click()
    await page.waitForTimeout(200)
    await expect(page.locator('.tabs-bar')).toBeVisible()
    await themeSwitcher.locator('button').nth(1).click()
    await page.waitForTimeout(200)
    await expect(page.locator('.tabs-bar')).toBeVisible()
    await app.close()
  })

  test('settings modal can be opened and closed repeatedly', async () => {
    const { app, page } = await launchApp()
    const settingsBtn = page.locator('.titlebar button[title="Settings"]')
    const modal = page.locator('.modal-overlay .modal')
    for (let i = 0; i < 3; i++) {
      await settingsBtn.click()
      await expect(modal).toBeVisible()
      await modal.getByRole('button', { name: 'Cancel' }).click()
      await expect(modal).not.toBeVisible()
    }
    await expect(page.locator('.tabs-bar')).toBeVisible()
    await app.close()
  })

  test('app survives opening settings from every tab', async () => {
    const { app, page } = await launchApp()
    const tabs = ['Launchpad', 'All Folders', 'Claude', 'Agents']
    const settingsBtn = page.locator('.titlebar button[title="Settings"]')
    const modal = page.locator('.modal-overlay .modal')
    for (const tabName of tabs) {
      await page.locator('.tab', { hasText: tabName }).click()
      await settingsBtn.click()
      await expect(modal).toBeVisible()
      await modal.getByRole('button', { name: 'Cancel' }).click()
      await expect(modal).not.toBeVisible()
    }
    await expect(page.locator('.tabs-bar')).toBeVisible()
    await expect(page).toHaveTitle(/DevHub-AI/)
    await app.close()
  })
})
