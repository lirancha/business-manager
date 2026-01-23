# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Business Manager is a restaurant management app for Zucca Café with multi-location support (Isgav, Frankfurt). It's a vanilla JavaScript SPA with Firebase Firestore backend. The UI is in Hebrew with full RTL support.

## Architecture

```
┌─────────────────┐         ┌─────────────────┐
│  HTML/JS files  │  ──────►│    Firebase     │
│  (in browser)   │         │  (cloud database)│
└─────────────────┘         └─────────────────┘
     Frontend                   Backend
     (your code)              (Google's servers)
```

**No build process** - Direct HTML/CSS/JS files served statically. No server-side code. Firebase handles data storage, real-time sync, and security. All logic runs in the browser.

**Tech stack:**
- Vanilla JavaScript (ES6+) with inline `<script>` tags
- Tailwind CSS v3 via CDN
- Firebase Firestore v10.7.1 (real-time listeners)
- Browser Notification API + Telegram Bot API for reminders
- No authentication (public access)

**Firebase config** is in each HTML file around lines 22-29.
**Firebase Console:** https://console.firebase.google.com/project/zucca-mang

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

## Firebase Database Structure

```
locations/
  ├── isgav
  │   ├── categories: [{id, name, products: [{id, name, quantity, unit}]}]
  │   └── taskLists: [{id, name, color, tasks: [{id, text, note, done}]}]
  └── frankfurt (same structure)

employee-schedules/
  ├── config
  │   ├── employees: [{id, name, phone}]
  │   └── shiftHours: {morning: {start, end}, afternoon: {...}, evening: {...}}
  └── {weekId} (e.g., "2024-01-21")
      ├── availability: {empId: {day: {shift: {available, customHours}}}}
      └── finalSchedule: {day: {shift: {location: [empIds]}}}

reminders/
  └── {reminderId}: {title, time, type, enabled, days/date}

backups/
  └── {backupId}: {categories, taskLists, location, backupTime}
```

## Data Flow

```
Manager makes change → saveState() → Firebase → onSnapshot → All devices update
```

Real-time sync: Both manager and employee views listen to the same Firebase documents. Changes appear instantly on all connected devices.

## State Management

In-memory state synced with Firebase:
```javascript
let state = { categories: [], taskLists: [] };
let reminders = [];
let scheduleEmployees = [];
let scheduleAvailability = {};
```

Key functions: `saveState()`, `loadState()`, `switchLocation(locationId)`, `switchTab(tab)`

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
