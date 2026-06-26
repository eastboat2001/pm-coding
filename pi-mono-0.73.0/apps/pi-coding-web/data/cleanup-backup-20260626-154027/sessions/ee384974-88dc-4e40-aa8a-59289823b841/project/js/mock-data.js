/**
 * Mock Data Layer — simulates C# API responses for the QDM Yield Dashboard.
 * Data grain: weekly. All filterable by Customer, Plant, DateType, LotType, UnitType, ProjectType.
 */

const MockDB = (() => {
  // ─── Utility ───────────────────────────────────────────────────────
  function weekLabel(isoDate) {
    const d = new Date(isoDate);
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const dayOfYear = Math.ceil((d - jan1) / 86400000);
    const week = Math.ceil(dayOfYear / 7);
    return `${d.getFullYear()}${String(week).padStart(2, '0')}`;
  }

  function addWeeks(dateStr, n) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + n * 7);
    return d.toISOString().slice(0, 10);
  }

  // ─── Reference Data ────────────────────────────────────────────────
  const customers = ['Customer_A', 'Customer_B', 'Customer_C'];
  const plants = ['Plant_1', 'Plant_2', 'Plant_3'];
  const dateTypes = ['Weekly', 'Monthly', 'Quarterly'];
  const lotTypes = ['HVM', 'NPI', 'Legacy'];
  const unitTypes = ['NSQM', 'NSOM'];
  const projectTypes = ['Overall', 'Project_X', 'Project_Y', 'Project_Z'];
  const departments = ['Etching + AOI', 'Assembly', 'Material', 'Bumping', 'Testing', 'Plating'];

  const defectCodes = [
    { code: 'ED25', desc: 'Short in inner layer' },
    { code: 'AP09', desc: 'Component tilting' },
    { code: 'GE01', desc: 'Scratches' },
    { code: 'MF12', desc: 'Missing solder paste' },
    { code: 'BK03', desc: 'Broken wire bond' },
    { code: 'CS07', desc: 'Cracked die' },
    { code: 'LD15', desc: 'Misalignment' },
    { code: 'VD04', desc: 'Void in bump' },
    { code: 'CO11', desc: 'Color deviation' },
    { code: 'PP18', desc: 'Pattern peel' },
    { code: 'IR06', desc: 'Incomplete reflow' },
    { code: 'EM22', desc: 'Electromigration' },
    { code: 'DL08', desc: 'Die lift' },
    { code: 'TF14', desc: 'Thin film crack' },
    { code: 'OX19', desc: 'Oxide defect' },
    { code: 'CL02', desc: 'Contamination' },
    { code: 'RN10', desc: 'Residue' },
    { code: 'WD16', desc: 'Wire deviation' },
    { code: 'FT05', desc: 'Finger trace' },
    { code: 'SP20', desc: 'Solder paste bridge' },
  ];

  // ─── Seed generator (deterministic) ────────────────────────────────
  function seededRandom(seed) {
    let s = seed;
    return () => {
      s = (s * 16807 + 0) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  // ─── FinishedLotSummary (DS-01) ────────────────────────────────────
  const startDate = '2026-03-16'; // Week 202612
  const numWeeks = 10;
  const finishedLotData = [];

  for (let w = 0; w < numWeeks; w++) {
    const atsDate = addWeeks(startDate, w);
    const wl = weekLabel(atsDate);
    // Trend: yield improves slightly over time
    const baseYield = 94.5 + w * 0.28;
    const rng = seededRandom(1000 + w * 7);

    customers.forEach((cust) => {
      plants.forEach((plant) => {
        lotTypes.forEach((lotType) => {
          unitTypes.forEach((unitType) => {
            projectTypes.forEach((projType) => {
              if (projType === 'Overall') {
                const yieldVal = Math.round((baseYield + (rng() - 0.5) * 1.8) * 100) / 100;
                const inputQty = Math.round(15000 + rng() * 5000 + w * 200);
                const outputQty = Math.round(inputQty * yieldVal / 100);
                finishedLotData.push({
                  Id: finishedLotData.length + 1,
                  ATSDate: atsDate,
                  WeekLabel: wl,
                  DateType: 'Weekly',
                  Customer: cust,
                  Plant: plant,
                  LotType: lotType,
                  UnitType: unitType,
                  ProjectType: projType,
                  Yield: yieldVal,
                  Output_NSQM: outputQty,
                  Input_Qty: inputQty,
                  FinishedCount: Math.round(100 + rng() * 80),
                });
              } else {
                // Sub-projects with partial data
                const fraction = projType === 'Project_X' ? 0.45 : projType === 'Project_Y' ? 0.35 : 0.20;
                const yieldVal = Math.round((baseYield + (rng() - 0.5) * 2.5) * 100) / 100;
                const inputQty = Math.round((15000 + rng() * 5000 + w * 200) * fraction);
                const outputQty = Math.round(inputQty * yieldVal / 100);
                finishedLotData.push({
                  Id: finishedLotData.length + 1,
                  ATSDate: atsDate,
                  WeekLabel: wl,
                  DateType: 'Weekly',
                  Customer: cust,
                  Plant: plant,
                  LotType: lotType,
                  UnitType: unitType,
                  ProjectType: projType,
                  Yield: yieldVal,
                  Output_NSQM: outputQty,
                  Input_Qty: inputQty,
                  FinishedCount: Math.round((100 + rng() * 80) * fraction),
                });
              }
            });
          });
        });
      });
    });
  }

  // ─── DefectSummary (DS-02) ─────────────────────────────────────────
  const defectData = [];

  for (let w = 0; w < numWeeks; w++) {
    const atsDate = addWeeks(startDate, w);
    const rng = seededRandom(5000 + w * 13);

    customers.forEach((cust) => {
      plants.forEach((plant) => {
        // Each week has top defect codes with varying quantities
        const numDefects = 8 + Math.floor(rng() * 8); // 8-15 defects per week/plant
        for (let d = 0; d < numDefects; d++) {
          const dcIdx = Math.floor(rng() * defectCodes.length);
          const qty = Math.round(5 + rng() * 80);
          const deptIdx = Math.floor(rng() * departments.length);
          defectData.push({
            Id: defectData.length + 1,
            ATSDate: atsDate,
            WeekLabel: weekLabel(atsDate),
            DateType: 'Weekly',
            DefectCode: defectCodes[dcIdx].code,
            DefectDesc: defectCodes[dcIdx].desc,
            DefectQty: qty,
            Department: departments[deptIdx],
            Customer: cust,
            Plant: plant,
          });
        }
      });
    });
  }

  // ─── Yield targets per week ────────────────────────────────────────
  const yieldTargets = {};
  for (let w = 0; w < numWeeks; w++) {
    const atsDate = addWeeks(startDate, w);
    yieldTargets[weekLabel(atsDate)] = 94.5 + w * 0.15;
  }

  // ─── Last updated timestamp ────────────────────────────────────────
  const lastUpdated = '2026-05-21 08:30:00';

  // ─── Public API ────────────────────────────────────────────────────
  return {
    customers,
    plants,
    dateTypes,
    lotTypes,
    unitTypes,
    projectTypes,
    departments,
    defectCodes,
    yieldTargets,
    lastUpdated,
    finishedLotData,
    defectData,

    // Simulate GET /api/filters
    getFilters() {
      return {
        customers: [...customers],
        plants: [...plants],
        dateTypes: [...dateTypes],
        lotTypes: [...lotTypes],
        unitTypes: [...unitTypes],
        projectTypes: [...projectTypes],
        defaults: {
          customer: [...customers],
          plant: [...plants],
          dateType: 'Weekly',
          lotType: 'HVM',
          unitType: 'NSQM',
          projectType: 'Overall',
        },
      };
    },

    // Simulate GET /api/yield/summary
    getSummary(filters) {
      const { dateType, lotType, unitType, projectType, customer, plant } = filters;
      const data = finishedLotData.filter((r) => {
        if (dateType && r.DateType !== dateType) return false;
        if (lotType && r.LotType !== lotType) return false;
        if (unitType && r.UnitType !== unitType) return false;
        if (projectType && r.ProjectType !== projectType) return false;
        if (customer && customer.length && !customer.includes(r.Customer)) return false;
        if (plant && plant.length && !plant.includes(r.Plant)) return false;
        return true;
      });

      // Aggregate by week
      const weekMap = {};
      data.forEach((r) => {
        if (!weekMap[r.WeekLabel]) {
          weekMap[r.WeekLabel] = {
            weekLabel: r.WeekLabel,
            atsDate: r.ATSDate,
            yieldSum: 0,
            outputSum: 0,
            inputSum: 0,
            finishedCountSum: 0,
            count: 0,
          };
        }
        const wk = weekMap[r.WeekLabel];
        wk.yieldSum += r.Yield;
        wk.outputSum += r.Output_NSQM;
        wk.inputSum += r.Input_Qty;
        wk.finishedCountSum += r.FinishedCount;
        wk.count += 1;
      });

      const trend = Object.values(weekMap)
        .map((w) => ({
          weekLabel: w.weekLabel,
          atsDate: w.atsDate,
          yield: Math.round((w.yieldSum / w.count) * 100) / 100,
          target: yieldTargets[w.weekLabel] || 94.8,
          output: w.outputSum,
          input: w.inputSum,
          finishedCount: w.finishedCountSum,
          nsqmLoss: w.outputSum - Math.round(w.inputSum * (w.yieldSum / w.count) / 100),
        }))
        .sort((a, b) => a.weekLabel.localeCompare(b.weekLabel));

      // Latest week KPIs
      const latest = trend[trend.length - 1] || {};
      const kpi = {
        yield: latest.yield || 0,
        target: latest.target || 94.8,
        finishedCount: latest.finishedCount || 0,
        output: latest.output || 0,
        nsqmLoss: latest.nsqmLoss || 0,
        input: latest.input || 0,
        yieldPass: (latest.yield || 0) >= (latest.target || 94.8),
      };

      return { trend, kpi, lastUpdated };
    },

    // Simulate GET /api/yield/defects
    getDefects(filters) {
      const { dateType, lotType, unitType, projectType, customer, plant } = filters;
      // Defects filtered by customer, plant, dateType (lotType/projectType not on defect table)
      const data = defectData.filter((r) => {
        if (dateType && r.DateType !== dateType) return false;
        if (customer && customer.length && !customer.includes(r.Customer)) return false;
        if (plant && plant.length && !plant.includes(r.Plant)) return false;
        return true;
      });

      // Aggregate by DefectCode
      const codeMap = {};
      data.forEach((r) => {
        if (!codeMap[r.DefectCode]) {
          codeMap[r.DefectCode] = {
            defectCode: r.DefectCode,
            defectDesc: r.DefectDesc,
            totalQty: 0,
            departments: {},
          };
        }
        const dc = codeMap[r.DefectCode];
        dc.totalQty += r.DefectQty;
        dc.departments[r.Department] = (dc.departments[r.Department] || 0) + r.DefectQty;
      });

      const totalDefectQty = Object.values(codeMap).reduce((s, c) => s + c.totalQty, 0);

      const pareto = Object.values(codeMap)
        .map((c) => ({
          defectCode: c.defectCode,
          defectDesc: c.defectDesc,
          defectQty: c.totalQty,
          lossRatio: totalDefectQty > 0 ? Math.round((c.totalQty / totalDefectQty) * 10000) / 100 : 0,
          departments: c.departments,
        }))
        .sort((a, b) => b.defectQty - a.defectQty)
        .slice(0, 20);

      // Core Loss = top 5 codes
      let coreQty = 0;
      pareto.slice(0, 5).forEach((p) => { coreQty += p.defectQty; });
      const coreLossRatio = totalDefectQty > 0 ? Math.round((coreQty / totalDefectQty) * 10000) / 100 : 0;

      return { pareto, totalDefectQty, coreLossRatio };
    },

    // Simulate GET /api/yield/details — drill-down for a specific defect code
    getDefectDetails(defectCode, filters) {
      const { customer, plant, dateType } = filters;
      const data = defectData.filter((r) => {
        if (dateType && r.DateType !== dateType) return false;
        if (customer && customer.length && !customer.includes(r.Customer)) return false;
        if (plant && plant.length && !plant.includes(r.Plant)) return false;
        if (r.DefectCode !== defectCode) return false;
        return true;
      });

      // Trend by week
      const weekMap = {};
      data.forEach((r) => {
        if (!weekMap[r.WeekLabel]) weekMap[r.WeekLabel] = { weekLabel: r.WeekLabel, qty: 0 };
        weekMap[r.WeekLabel].qty += r.DefectQty;
      });
      const trend = Object.values(weekMap).sort((a, b) => a.weekLabel.localeCompare(b.weekLabel));

      // Department distribution
      const deptMap = {};
      data.forEach((r) => {
        deptMap[r.Department] = (deptMap[r.Department] || 0) + r.DefectQty;
      });
      const departments = Object.entries(deptMap)
        .map(([name, qty]) => ({ name, qty }))
        .sort((a, b) => b.qty - a.qty);

      const defectDesc = data.length > 0 ? data[0].DefectDesc : '';

      return { defectCode, defectDesc, trend, departments };
    },

    // Simulate GET /api/yield/summary (for a specific week)
    getWeekDetail(weekLabel, filters) {
      const { lotType, unitType, projectType, customer, plant } = filters;
      const data = finishedLotData.filter((r) => {
        if (r.WeekLabel !== weekLabel) return false;
        if (lotType && r.LotType !== lotType) return false;
        if (unitType && r.UnitType !== unitType) return false;
        if (projectType && r.ProjectType !== projectType) return false;
        if (customer && customer.length && !customer.includes(r.Customer)) return false;
        if (plant && plant.length && !plant.includes(r.Plant)) return false;
        return true;
      });

      if (data.length === 0) return null;

      const yieldAvg = data.reduce((s, r) => s + r.Yield, 0) / data.length;
      const outputSum = data.reduce((s, r) => s + r.Output_NSQM, 0);
      const inputSum = data.reduce((s, r) => s + r.Input_Qty, 0);
      const finishedCountSum = data.reduce((s, r) => s + r.FinishedCount, 0);

      return {
        weekLabel,
        yield: Math.round(yieldAvg * 100) / 100,
        target: yieldTargets[weekLabel] || 94.8,
        output: outputSum,
        input: inputSum,
        finishedCount: finishedCountSum,
        nsqmLoss: outputSum - Math.round(inputSum * yieldAvg / 100),
      };
    },
  };
})();
