# System Design Document

> **Project:** D.CHQ.QDM Finished Lot Yield Dashboard  
> **Status:** Draft / Implementation Ready  
> **Version:** 1.0  
> **Stack:** C# (Backend), SQLite (Database), Vanilla JS/HTML/CSS (Frontend)

## 1. Scope and Objectives
The **D.CHQ.QDM Finished Lot Yield Dashboard** is designed to provide the Yield and QDM teams with an automated, high-level view of factory performance metrics. By replacing manual report preparation with a daily-updated automated system, the project aims to accelerate the yield improvement curve and reduce production costs.

*   **Objectives:**
    *   Expose overall yield trends and drill-down segments.
    *   Identify loss-code Pareto and loss-operation attribution.
    *   Drive faster ROI by highlighting root-cause ownership.
*   **In Scope:**
    *   Finished Lot Performance Overview Trend page.
    *   Loss Ratio By Defect Code page (Top 10-20 Pareto).
    *   Unified filter system (Customer, Plant, Date Type, etc.).
    *   Automated yield calculation logic (Lot-level and Weekly).
*   **Out of Scope:**
    *   Automated process-parameter optimization.
    *   QMS defect disposition workflow.
    *   Supplier/Customer complaint management.

## 2. Personas and Actors
| Actor | Role | Responsibilities |
| :--- | :--- | :--- |
| **Yield Team** | Business/Data Owner | Confirm metrics, validate data accuracy, review UI/UX. |
| **QDM Team** | Product Owner / Dev | Manage requirements, develop frontend/backend, maintain data contracts. |
| **Engineer** | End User | Analyze specific trend segments and product segments. |
| **Manager** | End User | Review high-level Pareto and department distribution. |
| **QA Tester** | Validator | Verify data against source tables and check responsiveness. |

## 3. System Use Cases

### UC-1: Review Weekly Performance
*   **Actor:** Yield Team / Manager
*   **Trigger:** User navigates to the Overview page.
*   **Preconditions:** Data sync from DS-01 is complete.
*   **Main Flow:** System loads default filters (Weekly, HVM, NSQM, Overall) and renders the Yield Trend line chart and latest-week KPI cards.
*   **Postconditions:** User sees current performance status.
*   **Acceptance Check:** Values match the latest records in `FinishedLotSummaryData`.

### UC-2: Interactive Drill-Down
*   **Actor:** Engineer
*   **Trigger:** User clicks a specific week/segment on the trend chart.
*   **Main Flow:** System captures the selected dimension, updates the right-side detail panel to show specific Output/Yield/Loss for that segment.
*   **Alternate Flow:** If no detail exists, show "No Data Available" in the detail panel.
*   **Acceptance Check:** Detail panel updates without a full page reload.

### UC-3: Defect Pareto Analysis
*   **Actor:** Manager / Yield Team
*   **Trigger:** User switches to the "Loss Ratio By Defect Code" page.
*   **Main Flow:** System aggregates defect data, ranks top 10-20 codes, and renders a Pareto chart and department distribution pie chart.
*   **Acceptance Check:** Pareto ranking matches DS-02 source data.

## 4. Functional Requirements
*   **FR-1: Unified Filtering:** Support Customer, Plant, Date Type (Weekly/Monthly/Quarterly), Lot Type, Unit Type, and Project Type.
*   **FR-2: Yield Calculation Engine:** Implement multiplication of sequential process yields (Output/Input) for lot-level and aggregated weekly views.
*   **FR-3: Interactive Visualizations:** Charts must support tooltips, legend toggling, and click-events for filtering.
*   **FR-4: Data Export:** Allow users to export filtered data/charts based on role permissions.
*   **FR-5: Responsive UI:** Layout must adapt to Desktop, Tablet, and Mobile widths.

# 5. Non-Functional Requirements
*   **Performance:** Chart refresh/query response < 3 seconds.
*   **Availability:** Data updated daily via scheduled script.
*   **Usability:** Follow AITC color system; keyboard-accessible legends.
*   **Reliability:** Chart-level error handling (one failing chart doesn't crash the page).
*   **Browser Support:** Latest Chrome and Edge.

## 6. High-Level Architecture
The system follows a standard 3-tier architecture using the default technology stack.

*   **Frontend:** Static HTML5, Bootstrap 5 (for layout), and Vanilla JavaScript (Fetch API for data, Chart.js or similar for rendering).
*   **Backend:** C# (ASP.NET Core Minimal API) providing RESTful endpoints.
*   **Database:** SQLite for local storage of aggregated summary data (DS-01/DS-02).

## 7. Module Responsibilities
*   **Web UI:** Handles user interactions, filter state management, and chart rendering.
*   **API Gateway (C#):** Routes requests, applies business logic/filtering, and formats JSON responses.
*   **Calculation Engine:** Logic for multiplying process yields and calculating loss ratios.
*   **Data Access Layer:** Executes SQLite queries against the summary tables.

## 8. API Design (Draft)

### 8.1 Get Summary Data
*   **Endpoint:** `GET /api/yield/summary`
*   **Params:** `customer`, `plant`, `dateType`, `lotType`, `unitType`, `projectType`
*   **Response:** JSON array of yield trend points and latest-week KPIs.

### 8.2 Get Defect Data
*   **Endpoint:** `GET /api/yield/defects`
*   **Params:** `customer`, `plant`, `dateType`, `lotType`
*   **Response:** JSON object containing Pareto data (Top 20) and department distribution.

### 8.3 Get Filter Metadata
*   **Endpoint:** `GET /api/metadata/filters`
*   **Response:** Available options for all dropdown filters.

## 9. Data Model and Database Design

### 9.1 Candidate Tables

#### Table: `FinishedLotSummary` (Ref: DS-01)
| Field | Type | Constraints | Purpose |
| :--- | :--- | :--- | :--- |
| `SummaryId` | INTEGER | PK, AutoInc | Unique ID |
| `ATSDate` | DATETIME | Indexed | Date of record |
| `DateType` | TEXT | | Weekly/Monthly/Quarterly |
| `Customer` | TEXT | Indexed | Customer Name |
| `Plant` | TEXT | | Plant Identifier |
| `LotType` | TEXT | | HVM, etc. |
| `Yield` | REAL | | Calculated Yield % |
| `Output_NSQM` | INTEGER | | Output Quantity |

#### Table: `DefectSummary` (Ref: DS-02)
| Field | Type | Constraints | Purpose |
| :--- | :--- | :--- | :--- |
| `DefectId` | INTEGER | PK, AutoInc | Unique ID |
| `ATSDate` | DATETIME | FK | Link to time period |
| `DefectCode` | TEXT | Indexed | Code identifier |
| `DefectQty` | INTEGER | | Quantity lost |
| `LossRatio` | REAL | | Calculated ratio |
| `Department` | TEXT | | Responsible Dept |

### 9.2 Relationships
*   `FinishedLotSummary` and `DefectSummary` are related via `ATSDate` and filter dimensions (Customer, Plant).
*   **Cardinality:** 1:N (One summary period has many defect records).

### 9.3 Data Constraints
*   `Yield` must be between 0 and 100.
*   `DefectQty` cannot be negative.
*   Indices on `ATSDate`, `Customer`, and `DefectCode` for query optimization.

## 10. Key Workflows / Sequence Narratives
1.  **Initialization:** Frontend calls `/api/metadata/filters` -> Populates dropdowns -> Calls `/api/yield/summary` with defaults.
2.  **Filter Update:** User changes "Plant" -> JS triggers Fetch -> API queries SQLite with `WHERE Plant = '...'` -> Charts update via `chart.update()`.
3.  **Drill-down:** User clicks "Week 22" bar -> JS filters local data or re-queries API for specific week details -> Right panel updates.

## 11. Security, Privacy, and Compliance
*   **Authentication:** Integrated with enterprise SSO (TBD).
*   **Authorization:** Export buttons are enabled/disabled based on user role (Yield Team vs. Guest).
*   **Data Privacy:** No PII (Personally Identifiable Information) is stored; data is aggregated factory metrics.

## 12. Observability and Operations
*   **Logging:** Backend logs API request duration and SQLite query errors.
*   **Data Freshness:** UI displays "Last Updated: [Timestamp]" based on the latest record in `FinishedLotSummary`.

## 13. Deployment and Environment Plan
*   **Dev:** Local SQLite, C# Kestrel server.
*   **QA:** Shared staging server for Yield team validation.
*   **Prod:** Production IIS/Kestrel server with daily automated data ingestion script.

## 14. Testing and Acceptance Plan
*   **Data Validation:** Compare dashboard Yield % against manual Excel calculations for 3 random weeks.
*   **UI Validation:** Verify "No Data" states and responsive layout on mobile (375px width).
*   **Performance:** Ensure Pareto chart renders < 2s for Top 20 codes.

## 15. Risks, Trade-offs, and Assumptions
*   **Assumption:** DS-01 and DS-02 tables are pre-aggregated by the daily script.
*   **Risk:** If the multiplication logic for yield changes, the backend calculation engine must be updated.
*   **Trade-off:** Using SQLite simplifies deployment but requires the daily script to handle the write-heavy ingestion process.

## 16. Milestones and Delivery Plan
*   **M1:** Database schema and API scaffolding (C#).
*   **M2:** Filter bar and Overview Trend page (Frontend).
*   **M3:** Defect Pareto page and Drill-down logic.
*   **M4:** QA validation and Production release.

## 17. Open Questions / Missing Inputs
*   **Layout:** Which layout option is the approved default: Primary-Detail / Hero, Uniform Grid, or Tabbed?
*   **Data:** What are the final join keys for DS-01 and DS-02?
*   **Permissions:** Which specific roles are allowed to export raw data vs. chart images?
*   **SLA:** What is the required data availability time (e.g., 8:00 AM daily)?