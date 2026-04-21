import { test, expect } from '@playwright/test'
import { launchApp } from './electron-helpers'

test.describe('App Launch', () => {
  test('window opens with correct title', async () => {
    const { app, page } = await launchApp()
    const title = await page.title()
    expect(title).toContain('DevHub-AI')
    await app.close()
  })

  test('titlebar renders with app name', async () => {
    const { app, page } = await launchApp()
    const titlebar = page.locator('.titlebar')
    await expect(titlebar).toBeVisible()
    await expect(titlebar).toContainText('DevHub-AI')
    await app.close()
  })

  test('tab bar renders with all tabs', async () => {
    const { app, page } = await launchApp()
    await expect(page.locator('.tabs-bar')).toBeVisible()
    await expect(page.locator('.tab').nth(0)).toContainText('Launchpad')
    await expect(page.locator('.tab').nth(1)).toContainText('All Folders')
    await expect(page.locator('.tab').nth(2)).toContainText('Claude')
    await expect(page.locator('.tab').nth(3)).toContainText('Agents')
    await app.close()
  })

  test('theme switcher is visible', async () => {
    const { app, page } = await launchApp()
    const switcher = page.locator('.theme-switcher')
    await expect(switcher).toBeVisible()
    await app.close()
  })
})
