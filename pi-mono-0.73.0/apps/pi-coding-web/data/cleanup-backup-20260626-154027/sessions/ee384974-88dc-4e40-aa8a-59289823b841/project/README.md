# QDM Finished Lot Yield Dashboard

## Overview

A production-quality static dashboard for visualizing **Finished Lot Yield Performance** and **Defect Loss Ratio** analysis for the QDM (Quality Data Management) team. Built following AITC Enterprise design guidelines.

## Features

1. **Finished Lot Performance Overview Trend**
   - Bar/line combo chart showing weekly yield trends and output volume
   - Interactive: click any week bar to update the KPI panel
   - KPI cards: Yield/Target, Finished Count, Output (NSQM), NSQM Loss

2. **Loss Ratio By Defect Code (Pareto Analysis)**
   - Horizontal bar chart ranking defect codes by loss ratio
   - Red bars = Total Loss Ratio; Blue bars = Core Loss Ratio (top 5)
   - Interactive: click any defect code to drill down

3. **Drill-down Panel**
   - Weekly trend line chart for the selected defect code
   - Donut chart showing department attribution (Etching+AOI, Assembly, Material, etc.)

4. **Unified Filter Bar** (Sidebar)
   - Customer (multi-select), Plant (multi-select)
   - Date Type, Lot Type, Unit Type, Project Type (single-select)
   - All filters update charts in real-time without page reload

5. **Export to CSV**
   - Includes active filter context in header and filename

6. **Responsive Design**
   - Desktop: sidebar + main content layout
   - Tablet: stacked KPI cards, full-width charts
   - Mobile: collapsible filter sidebar, stacked charts

## Tech Stack

- **HTML5** + **CSS3** (no Bootstrap, custom AITC-compliant design system)
- **JavaScript** (Vanilla, no framework dependencies)
- **Chart.js 4.4.4** (via CDN) for data visualization
- **Static files only** — no backend, no build step required

## File Structure

```
index.html              — Main entry point
css/style.css           — AITC Enterprise design system styles
js/mock-data.js         — Mock data layer (simulates backend API)
js/app.js               — Application logic (filters, charts, interactions)
docs/                   — PRD and Design documents
```

## How to Run

### Option 1: Direct File Open
Simply open `index.html` in any modern browser (Chrome, Edge, Firefox).

### Option 2: Local Server
```bash
# Python
python -m http.server 8080

# Node.js
npx serve .

# Or use the preview server
```

## How to Verify

1. **Default Load**: Dashboard loads with Weekly/HVM/NSQM/Overall filters; trend chart shows 10 weeks of data; KPI cards display latest week metrics
2. **Filter Interaction**: Change any filter → charts update asynchronously within 300ms
3. **Week Click**: Click a bar on the trend chart → KPI panel updates to that week
4. **Defect Drill-down**: Click a defect code on the Pareto chart → right panel shows trend + department donut
5. **Export**: Click "Export" button → CSV file downloads with filter context
6. **Responsive**: Resize browser to tablet/mobile widths → layout adapts

## Data Model

### FinishedLotSummary (DS-01)
| Field | Type | Description |
|-------|------|-------------|
| ATSDate | DATE | Week start date |
| WeekLabel | TEXT | Year+Week format (e.g., "202612") |
| DateType | TEXT | Weekly/Monthly/Quarterly |
| Customer | TEXT | Customer name |
| Plant | TEXT | Plant identifier |
| LotType | TEXT | HVM/NPI/Legacy |
| UnitType | TEXT | NSQM/NSOM |
| ProjectType | TEXT | Overall/Project_X/Y/Z |
| Yield | REAL | Yield percentage |
| Output_NSQM | INTEGER | Output quantity |
| Input_Qty | INTEGER | Input quantity |
| FinishedCount | INTEGER | Number of finished lots |

### DefectSummary (DS-02)
| Field | Type | Description |
|-------|------|-------------|
| ATSDate | DATE | Week start date |
| DefectCode | TEXT | Defect code (e.g., ED25, AP09) |
| DefectDesc | TEXT | Defect description |
| DefectQty | INTEGER | Defect quantity |
| Department | TEXT | Responsible department |
| Customer | TEXT | Customer name |
| Plant | TEXT | Plant identifier |

## Mock API Endpoints (Simulated)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `MockDB.getFilters()` | — | Returns filter options and defaults |
| `MockDB.getSummary(filters)` | — | Returns yield trend + KPI for filters |
| `MockDB.getDefects(filters)` | — | Returns Pareto data for defect codes |
| `MockDB.getDefectDetails(code, filters)` | — | Returns drill-down trend + dept donut |

## Known Assumptions

1. **No real backend**: Data is fully simulated with deterministic seeded random data. The PRD references a C# ASP.NET Core backend with SQLite, but PI delivers static preview only.
2. **Sync service is external**: The automated data sync from `QDMProductionDB` to SQLite is handled externally per design doc assumption.
3. **Authentication**: Corporate SSO integration is TBD per design doc; no auth is implemented in this static preview.
4. **Export permissions**: Role-based export control is noted in requirements but not enforced in this static preview (all users can export).
5. **NSQM vs NSOM**: Labels default to "NSQM" per PRD default; the Unit Type filter allows switching but the dashboard title uses NSQM.

## Color System (AITC Compliance)

| Token | Value | Usage |
|-------|-------|-------|
| Primary Blue | #2563eb | Actions, active states |
| Background | #f6f8fb | Page background |
| Panel | #ffffff | Cards, panels |
| Border | #d9e1e7 | Dividers, inputs |
| Danger | #c2413b | Errors, below-target yield |
| Text Primary | #111315 | Main text |
| Text Secondary | #424a55 | Labels, metadata |
| Text Muted | #647280 | Timestamps, hints |
