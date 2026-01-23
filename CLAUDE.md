# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Business Manager is a restaurant management app for Zucca Café with multi-location support (Isgav, Frankfurt). It's a vanilla JavaScript SPA with AWS backend (API Gateway + Lambda + DynamoDB). The UI is in Hebrew with full RTL support.

## Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│  HTML/JS files  │  ──────►│  API Gateway    │  ──────►│    DynamoDB     │
│  (in browser)   │         │  + Lambda       │         │    (storage)    │
└─────────────────┘         └─────────────────┘         └─────────────────┘
     Frontend                   Backend                   Database
     (GitHub Pages)           (AWS serverless)           (AWS managed)
```

**No build process** - Direct HTML/CSS/JS files served statically from GitHub Pages. Backend is AWS Lambda + API Gateway. All logic runs in the browser.

**Tech stack:**
- Vanilla JavaScript (ES6+) with inline `<script>` tags
- Tailwind CSS v3 via CDN
- AWS API Gateway + Lambda (`lambda/index.js`)
- AWS DynamoDB (5 tables: locations, schedules, reminders, backups, sent-reminders)
- Polling-based sync via `api-client.js` (5-second interval)
- Server-side reminders via Lambda + EventBridge cron (works 24/7)
- Telegram Bot API for notifications (credentials in AWS Secrets Manager)
- No authentication (public access)

**API config** is in each HTML file - look for `API_BASE_URL` near the top of the `<script>` tag.

## Files & Features

| File | Purpose | Lines |
|------|---------|-------|
| `index.html` | Manager dashboard - full control | ~2700 |
| `employee.html` | Staff view - limited access | ~1240 |
| `import-inventory.html` | Bulk import categories | ~395 |
| `import-tasks.html` | Import task list templates | ~146 |
| `migrate-data.html` | Restore data utility | ~104 |

**Manager tabs (index.html):**
- Inventory: Create categories, add products, track quantities, generate orders, share via WhatsApp/Email
- Tasks: Create task lists (8 colors), add/edit/delete tasks, drag-to-reorder, share progress
- Schedule: Add employees, set shift hours, view availability, build schedule, send to all
- Reminders: Create recurring/one-time reminders, browser + Telegram notifications

**Employee tabs (employee.html):**
- Inventory: View only, track shortages, share status
- Tasks: View tasks, mark complete, share progress
- Schedule: Submit availability (full/partial shifts), view assigned shifts

## DynamoDB Database Structure

```
business-manager-locations/
  ├── id: "isgav" or "frankfurt"
  ├── categories: [{id, name, products: [{id, name, quantity, unit}]}]
  ├── taskLists: [{id, name, color, tasks: [{id, text, note, done}]}]
  └── version: number (for change detection)

business-manager-schedules/
  ├── id: "config" → { employees: [...], shiftHours: {...} }
  └── id: "week-{weekId}" → { availability: {...}, finalSchedule: {...} }

business-manager-reminders/
  └── id: "{reminderId}" → { title, time, type, enabled, days, date }

business-manager-backups/
  └── id: "{backupId}" → { categories, taskLists, location, backupTime }

business-manager-sent-reminders/
  └── id: "{reminderId}-{DD-MM-YYYY}" → { reminderId, sentAt, expiresAt (TTL) }
```

## AWS Resources

**Lambda Functions:**
- `business-manager-api` - Main API handler (API Gateway backend)
- `business-manager-reminder-checker` - Cron-triggered reminder checker

**EventBridge:**
- `business-manager-reminder-cron` - Triggers reminder checker every minute

**Secrets Manager:**
- `business-manager/telegram` - Telegram bot token and chat ID

**IAM Roles:**
- `business-manager-lambda-role` - For main API Lambda
- `business-manager-reminder-checker-role` - For reminder checker Lambda

## Data Flow

```
Manager makes change → saveState() → API call → Lambda → DynamoDB
                                                   ↓
Other devices poll every 5s ← ────────────────────┘
```

Near real-time sync: Both manager and employee views poll the API every 5 seconds. Changes appear on all connected devices within a few seconds.

## State Management

In-memory state synced with AWS API:
```javascript
let state = { categories: [], taskLists: [] };
let reminders = [];
let scheduleEmployees = [];
let scheduleAvailability = {};
```

Key functions: `saveState()`, `loadState()`, `switchLocation(locationId)`, `switchTab(tab)`

**API Client:** The `api` object (instance of `BusinessManagerAPI` from `api-client.js`) provides:
- `api.saveLocation(id, data)` - Save location data
- `api.subscribeLocation(id, callback)` - Poll for location changes
- `api.getScheduleConfig()` / `api.saveScheduleConfig(data)` - Employees & shift hours
- `api.getScheduleWeek(weekId)` / `api.saveScheduleWeek(weekId, data)` - Weekly schedules
- `api.listReminders()` / `api.createReminder(data)` / `api.updateReminder(id, data)` / `api.deleteReminder(id)` - Reminders
- `api.getTelegramSettings()` / `api.saveTelegramSettings(botToken, chatId)` / `api.testTelegram()` - Telegram config

## Data Protection

- `saveState()` blocks saving if both `categories` and `taskLists` are empty (prevents accidental data wipe)
- Automatic backups created before each save to `backups` collection

## RTL Considerations

- Hebrew text uses `dir="rtl"` on specific elements, not the html root
- Dates formatted as DD/MM to avoid RTL confusion
- Force LTR alignment on specific UI elements (task checkboxes, progress indicators)

## Mobile-Specific Features

- Long-press gesture (500ms) for +5/-5 quantity adjustments
- Touch-optimized with haptic feedback via Vibration API
- Viewport configured for iOS (`viewport-fit=cover`)

## Reminder System (Server-Side)

Reminders work 24/7 without the browser being open:

```
EventBridge (every minute) → reminder-checker Lambda → Telegram Bot API
                                      ↓
                              DynamoDB (reminders table)
                                      ↓
                              sent-reminders table (prevents duplicates)
```

**Flow:**
1. EventBridge triggers `business-manager-reminder-checker` every minute
2. Lambda gets Telegram credentials from Secrets Manager
3. Scans reminders table for enabled reminders
4. Filters by current time (Israel timezone) and day/date
5. Checks sent-reminders table to prevent duplicate sends
6. Sends Telegram notification
7. Records in sent-reminders with 7-day TTL
8. One-time reminders auto-disable after sending

**Day names (Hebrew):** ראשון, שני, שלישי, רביעי, חמישי, שישי, שבת

---

## Checkpoint: 2026-01-23

**Commit:** `f490421` - Move reminder notifications from browser to AWS Lambda + EventBridge cron

**What's working:**
- Full inventory management (categories, products, quantities)
- Task lists with 8 colors, drag-to-reorder
- Employee schedule system (availability, final schedule)
- Server-side reminders via Telegram (works 24/7)
- Multi-location support (Isgav, Frankfurt)
- Real-time sync across devices (5-second polling)
- Data protection (blocks empty saves, auto-backups)

**AWS Infrastructure:**
- API Gateway: `https://98mctlbso0.execute-api.eu-central-1.amazonaws.com/prod`
- Region: `eu-central-1`
- Account: `770493140072`

**Telegram:** Configured and tested - notifications sent successfully even with browser closed.
