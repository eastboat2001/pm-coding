# D.CHQ.QDM Finish Yield Dashboard Requirement

## 1. Basic Document Information

| Field | Value |
| --- | --- |
| Template name | QDM Finished Lot Yield Dashboard Requirement Template |
| Document name | D.CHQ.QDM Finish Yield Dashboard Requirement |
| System / Module | FinishedLot |
| Initiating department | QDM |
| Author / requester | Ely Yi |
| Version | V1.0 |
| Creation date | 2026-05-21 |
| Business domain | Manufacturing quality / finished lot yield / QDM dashboard |
| Status | Draft |
| Target release | TBD |

---

## 2. Background and Objectives

### 2.1 Background
The dashboard provides a high-level view of key yield metrics for various factory products. It is updated via automated scheduled scripts to allow QDM and yield teams to review performance without manual preparation.

### 2.2 Objectives
*   **Yield Improvement:** Visualize trends to drive a steeper improvement curve.
*   **Cost Efficiency:** Reduce production costs by identifying loss drivers.
*   **Output Optimization:** Increase production output without additional capital expenditure.
*   **Investment Recovery:** Accelerate ROI through better quality control.

### 2.3 Success Criteria
*   Users can identify the latest finished lot yield, output, and major defect contributors from the primary screen.
*   Drill-down functionality allows navigation from yield trends to specific defect codes and responsible departments.
*   Dashboard data matches approved source query results under representative filters.

---

## 3. Page / Function Presentation

### 3.1 Finished Lot Performance Overview Trend
*   **Purpose:** Display finished yield trends and latest-week KPIs (Output, Yield, NSQM Loss).
*   **Header:** `QUALITY OPERATION CENTER - Weekly Finished Lot Performance Overview`.
*   **Main Chart:** A large "Weekly Finished Lot Performance Overview Trend" chart (Bar + Line combo).
    *   **X-Axis:** Time periods (e.g., Week 202612 to 202621).
    *   **Y-Axis:** Yield rate (Line) and Output (Bars).
    *   **Interaction:** Clicking a weekly bar updates the right-side detail panel and the defect analysis section.
*   **Right Panel (KPI Cards):** Displays details for the selected week:
    *   Yield / Target (e.g., 96.83% / 94.81%)
    *   Finished Count (e.g., 159 Lots)
    *   Output (NSQM/NSOM)
    *   Loss (NSQM/NSOM)

### 3.2 Loss Ratio By Defect Code
*   **Purpose:** Display top 10–20 defect loss ratios and their trends.
*   **Main Chart:** Ranked horizontal bar chart showing "Top Loss Ratio By Defect Code".
    *   **Visuals:** Red bars for Total Loss Ratio; Blue bars for Core Loss Ratio.
    *   **Interaction:** Selecting a defect code (e.g., ED25 - Short in inner layer) updates the right-side trend and attribution.
*   **Right-Side Detail:**
    *   **Trend Chart:** Weekly overview trend for the selected defect code.
    *   **Donut Chart:** Department attribution (e.g., Etching + AOI, Assembly, Material).

---

## 4. Query Conditions and User Interactions

### 4.1 Filters
The dashboard uses a unified filter bar (two-row, three-column layout).

| Filter | Control Type | Default Value | Applies To |
| --- | --- | --- | --- |
| Customer | Dropdown | All selected | All charts |
| Plant | Dropdown | All selected | All charts |
| Date Type | Dropdown | Weekly | All charts |
| Lot Type | Dropdown | HVM | All charts |
| Unit Type | Dropdown | NSQM | All charts |
| Project Type | Dropdown | Overall | All charts |

### 4.2 Interaction Rules
*   **Asynchronous Updates:** Filter changes should update charts without a full page reload.
*   **Visual Feedback:** Selected chart segments must be highlighted.
*   **Tooltips:** Must be readable on desktop; tap-friendly on touch devices.
*   **Export:** Must include applied filter context and respect data permissions.

---

## 5. Data Description and Data Contract

### 5.1 Data Sources
| Source ID | Table / View / API | Grain | Refresh Cadence |
| --- | --- | --- | --- |
| DS-01 | `[QDMProductionDB].[IDA].[Yield_Dashboard_FinishedLotSummaryData_Internal]` | Weekly/Monthly | Daily (Scripted) |
| DS-02 | `[QDMProductionDB].[IDA].[Yield_Dashboard_FinishedLotSummaryDefectData_Internal]` | Weekly/Monthly | Daily (Scripted) |

### 5.2 Required Data Fields (Key)
*   `ATSDate`: Period comparison and filtering.
*   `Yield`: Key finished yield metric.
*   `Output_NSQM`: Key output metric.
*   `DefectCode`: Ranking and drill-down.
*   `Department`: Loss attribution.

---

## 6. Yield Calculation Logic

### 6.1 Finished Yield Definition
Finished Yield (Product Yield) is the product of individual process yields across the full manufacturing path.

### 6.2 Formula
*   **Lot Product Yield:** `(Process A Output / Input) x (Process B Output / Input) x ... x (Process N Output / Input)`
*   **Weekly Product Yield:** Calculated using the product of each process's weekly aggregated shipped output/input ratios.
*   **Standard Path:** PAOI → E-test → CCAOI → Bump AOI → FVI.
*   **Assumption:** If "Inline" or "Others" are present in the data for a specific project, they are included in the multiplication chain.

---

# 7. Page / Function Layout
*   **Recommended Default:** **Primary-Detail / Hero Layout**.
*   **Structure:** One large hero chart (Trend or Pareto) on the left/top, with supporting KPI cards and detail charts on the right/bottom.

---

## 8. Chart Inventory and Configuration

| Chart ID | Chart Name | Type | Interaction |
| --- | --- | --- | --- |
| CH-01 | Finished Overall Trend | Line + Bar | Click bar to filter detail panel. |
| CH-02 | Defect Loss Ratio | Horizontal Bar | Click code to update trend/department charts. |
| CH-03 | Detail Charts | Table/Line/Pie | Supports sorting, pagination, and export. |

---

## 9. Responsible Parties and Stakeholders

| Role | Team | Responsibility |
| --- | --- | --- |
| Business Owner | Yield Team | Confirm metrics and acceptance. |
| Product Owner | QDM | Requirement maintenance and coordination. |
| Data Owner | Yield Team | Source table and logic confirmation. |
| Frontend Dev | QDM | Implementation (HTML/Bootstrap/jQuery). |

---

## 10. UI and Visual Design Requirements
*   **Color System:** Background `#f6f8fb`, Panels `#ffffff`, Primary Blue `#2563eb`.
*   **Typography:** Arial Nova or Plus Jakarta Sans.
*   **Spacing:** 8px rhythm; 8px border radius for cards.
*   **States:** Must define Loading, Empty, Error, and Active states.

---

## 11. Technical and Non-functional Requirements
*   **Performance:** Target chart refresh within 3 seconds.
*   **Responsiveness:** Support Desktop, Tablet, and Mobile (stacking charts vertically).
*   **Security:** Role-based access control for data exports.
*   **Accuracy:** Values must match source query results exactly.

---

## 12. Acceptance Criteria
1.  Business owner confirms chart list, metric definitions, and layout.
2.  Data owner confirms source tables, field mapping, and join logic.
3.  Charts render correctly for default filters and at least three filter combinations.
4.  Loading, empty, and error states are visually consistent.
5.  Page is responsive across desktop, tablet, and mobile widths.
6.  Export behavior follows permission rules and includes filter context.
7.  QA verifies data accuracy against source queries.
8.  UI follows the approved AITC color system (no unapproved primary colors).

---

## 13. Open Questions and Decisions Needed

| ID | Question / Decision | Owner | Status |
| --- | --- | --- | --- |
| Q-01 | Is **Primary-Detail / Hero** the final approved layout? | Business Owner | Open |
| Q-02 | Confirm final join keys for DS-01 and DS-02. | Data Owner | Open |
| Q-03 | Should the KPI label be **NSQM** or **NSOM**? | Business Owner | Open |
| Q-04 | Does the yield formula include "Inline" and "Others" for all products? | Data Owner | Open |
| Q-05 | Define specific user roles allowed to export raw data. | Security | Open |

---

## 14. Appendix A. Color System

| Token | Value |
| --- | --- |
| Background | `#f6f8fb` |
| Panel | `#ffffff` |
| Primary Blue | `#2563eb` |
| Primary Text | `#111315` |
| Border | `#d9e1e7` |
| Danger/Error | `#c2413b` |