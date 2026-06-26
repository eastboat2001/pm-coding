/* ============================================================
   Mock Data Layer — Simulates SQLite / API responses
   ============================================================ */

const MockDB = (() => {

  // --- Helper: generate week keys ---
  const weeks = ['202612','202613','202614','202615','202616','202617','202618','202619','202620','202621'];
  const weekLabels = ['W12','W13','W14','W15','W16','W17','W18','W19','W20','W21'];
  const weekDates = [
    'Mar 16 - Mar 22','Mar 23 - Mar 29','Mar 30 - Apr 5','Apr 6 - Apr 12',
    'Apr 13 - Apr 19','Apr 20 - Apr 26','Apr 27 - May 3','May 4 - May 10',
    'May 11 - May 17','May 18 - May 24'
  ];

  const customers = ['All','Customer_A','Customer_B','Customer_C','Customer_D','Customer_E'];
  const plants = ['All','Plant_1','Plant_2','Plant_3'];
  const dateTypes = ['Weekly','Monthly','Quarterly'];
  const lotTypes = ['All','HVM','NPI','Engineering'];
  const unitTypes = ['NSQM','NSOM'];
  const projectTypes = ['Overall','Project_X','Project_Y','Project_Z'];

  // --- DS-01: FinishedLotSummary ---
  // Simulates [QDMProductionDB].[IDA].[Yield_Dashboard_FinishedLotSummaryData_Internal]
  const summaryData = [];
  let summaryId = 1;

  // Base metrics per customer/plant — realistic manufacturing data
  const baseMetrics = {
    'Customer_A': { yieldBase: 96.8, outputBase: 820, inputBase: 847 },
    'Customer_B': { yieldBase: 95.2, outputBase: 640, inputBase: 672 },
    'Customer_C': { yieldBase: 97.5, outputBase: 510, inputBase: 523 },
    'Customer_D': { yieldBase: 94.1, outputBase: 380, inputBase: 404 },
    'Customer_E': { yieldBase: 96.3, outputBase: 290, inputBase: 301 },
  };

  const plantYieldAdj = { 'Plant_1': 0.3, 'Plant_2': -0.1, 'Plant_3': 0.5 };

  function seededRandom(seed) {
    let x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  weeks.forEach((week, wi) => {
    Object.keys(baseMetrics).forEach((customer, ci) => {
      Object.keys(plantYieldAdj).forEach((plant, pi) => {
        const seed = wi * 100 + ci * 10 + pi;
        const r = seededRandom(seed);
        const trendAdj = wi * 0.08; // slight upward trend over weeks
        const noise = (r - 0.5) * 1.2;

        const yieldVal = Math.round((baseMetrics[customer].yieldBase + plantYieldAdj[plant] + trendAdj + noise) * 100) / 100;
        const inputQty = Math.round(baseMetrics[customer].inputBase * (1 + (r - 0.5) * 0.15));
        const outputNSQM = Math.round(inputQty * (yieldVal / 100));
        const lotCount = Math.round(outputNSQM * 0.095);

        // NSQM Loss
        const nsqmLoss = inputQty - outputNSQM;
        const nsomLoss = Math.round(nsqmLoss * 0.87);

        summaryData.push({
          Id: summaryId++,
          ATSDate: week,
          DateType: 'Weekly',
          Customer: customer,
          Plant: plant,
          LotType: 'HVM',
          UnitType: 'NSQM',
          ProjectType: 'Overall',
          Yield: yieldVal,
          Output_NSQM: outputNSQM,
          Input_Qty: inputQty,
          LotCount: lotCount,
          NSQM_Loss: nsqmLoss,
          NSOM_Loss: nsomLoss,
        });
      });
    });
  });

  // --- DS-02: DefectSummary ---
  // Simulates [QDMProductionDB].[IDA].[Yield_Dashboard_FinishedLotSummaryDefectData_Internal]
  const defectCodes = [
    { code: 'ED25', name: 'Short in Inner Layer', dept: 'Etching + AOI', baseRatio: 14.2 },
    { code: 'AP09', name: 'Component Tilting', dept: 'Assembly', baseRatio: 11.8 },
    { code: 'GE01', name: 'Scratches', dept: 'Handling', baseRatio: 9.5 },
    { code: 'ED12', name: 'Open Circuit', dept: 'Etching + AOI', baseRatio: 8.1 },
    { code: 'BC03', name: 'Solder Bridge', dept: 'Assembly', baseRatio: 7.4 },
    { code: 'VI05', name: 'Missing Component', dept: 'Assembly', baseRatio: 6.8 },
    { code: 'ED08', name: 'Etch Residue', dept: 'Etching + AOI', baseRatio: 5.9 },
    { code: 'GE04', name: 'Contamination', dept: 'Clean Room', baseRatio: 5.2 },
    { code: 'BT02', name: 'Bump Defect', dept: 'Bumping', baseRatio: 4.7 },
    { code: 'CC07', name: 'Crack', dept: 'Material', baseRatio: 4.1 },
    { code: 'FV03', name: 'FVI Reject', dept: 'FVI', baseRatio: 3.8 },
    { code: 'IN01', name: 'Inline Reject', dept: 'Inline', baseRatio: 3.2 },
    { code: 'OT05', name: 'Other Visual', dept: 'FVI', baseRatio: 2.8 },
    { code: 'AP11', name: 'Misalignment', dept: 'Assembly', baseRatio: 2.4 },
    { code: 'GE09', name: 'Denting', dept: 'Handling', baseRatio: 2.1 },
  ];

  const defectData = [];
  let defectId = 1;

  // For each defect code, generate data across weeks
  defectCodes.forEach((dc, di) => {
    // Department breakdown for this defect
    const deptBreakdown = getDeptBreakdown(dc);

    weeks.forEach((week, wi) => {
      const seed = di * 100 + wi;
      const r = seededRandom(seed);
      const trendAdj = wi * 0.03;
      const noise = (r - 0.5) * 2.5;
      const lossRatio = Math.round((dc.baseRatio + trendAdj + noise) * 100) / 100;
      const defectQty = Math.round(50 + lossRatio * 8 + (r * 20));

      defectData.push({
        Id: defectId++,
        ATSDate: week,
        DateType: 'Weekly',
        DefectCode: dc.code,
        DefectName: dc.name,
        Department: deptBreakdown.primary,
        DefectQty: defectQty,
        LossRatio: lossRatio,
        Customer: 'All',
        Plant: 'All',
        LotType: 'HVM',
        UnitType: 'NSQM',
        ProjectType: 'Overall',
      });
    });
  });

  function getDeptBreakdown(dc) {
    const deptMap = {
      'Etching + AOI': { primary: 'Etching + AOI', secondary: ['Assembly','Material'] },
      'Assembly': { primary: 'Assembly', secondary: ['Etching + AOI','Material'] },
      'Handling': { primary: 'Handling', secondary: ['Clean Room','Assembly'] },
      'Clean Room': { primary: 'Clean Room', secondary: ['Etching + AOI','Handling'] },
      'Bumping': { primary: 'Bumping', secondary: ['Assembly','Material'] },
      'Material': { primary: 'Material', secondary: ['Etching + AOI','Assembly'] },
      'FVI': { primary: 'FVI', secondary: ['Assembly','Handling'] },
      'Inline': { primary: 'Inline', secondary: ['Assembly','Material'] },
    };
    return deptMap[dc.dept] || { primary: dc.dept, secondary: ['Other'] };
  }

  // --- Public API (simulates /api/* endpoints) ---
  return {
    getFilters() {
      return {
        customers,
        plants,
        dateTypes,
        lotTypes,
        unitTypes,
        projectTypes,
      };
    },

    getSummary(filters = {}) {
      let data = [...summaryData];
      if (filters.customer && filters.customer !== 'All')
        data = data.filter(d => d.Customer === filters.customer);
      if (filters.plant && filters.plant !== 'All')
        data = data.filter(d => d.Plant === filters.plant);
      if (filters.lotType && filters.lotType !== 'All')
        data = data.filter(d => d.LotType === filters.lotType);
      if (filters.unitType)
        data = data.filter(d => d.UnitType === filters.unitType);
      if (filters.projectType && filters.projectType !== 'Overall')
        data = data.filter(d => d.ProjectType === filters.projectType);

      // Aggregate by week (average yield, sum output, etc.)
      const weekMap = {};
      data.forEach(d => {
        if (!weekMap[d.ATSDate]) {
          weekMap[d.ATSDate] = {
            ATSDate: d.ATSDate,
            totalOutput: 0,
            totalInput: 0,
            totalLots: 0,
            totalNSQMLoss: 0,
            totalNSOMLoss: 0,
            yieldSum: 0,
            count: 0,
          };
        }
        const w = weekMap[d.ATSDate];
        w.totalOutput += d.Output_NSQM;
        w.totalInput += d.Input_Qty;
        w.totalLots += d.LotCount;
        w.totalNSQMLoss += d.NSQM_Loss;
        w.totalNSOMLoss += d.NSOM_Loss;
        w.yieldSum += d.Yield;
        w.count++;
      });

      const trend = weeks.map((week, i) => {
        const w = weekMap[week];
        if (!w) return null;
        return {
          ATSDate: week,
          WeekLabel: weekLabels[i],
          WeekDate: weekDates[i],
          Yield: Math.round((w.yieldSum / w.count) * 100) / 100,
          Target: 94.81 + (i * 0.05),
          Output_NSQM: w.totalOutput,
          Input_Qty: w.totalInput,
          LotCount: w.totalLots,
          NSQM_Loss: w.totalNSQMLoss,
          NSOM_Loss: w.totalNSOMLoss,
        };
      }).filter(Boolean);

      // Latest week KPIs
      const latest = trend[trend.length - 1] || {};

      return {
        trend,
        kpi: {
          yield: latest.Yield || 0,
          target: latest.Target || 94.81,
          outputNSQM: latest.Output_NSQM || 0,
          outputNSOM: Math.round((latest.Output_NSQM || 0) * 0.87),
          lotCount: latest.LotCount || 0,
          nsqmLoss: latest.NSQM_Loss || 0,
          nsomLoss: latest.NSOM_Loss || 0,
          inputQty: latest.Input_Qty || 0,
        },
        weekCount: trend.length,
      };
    },

    getDefects(filters = {}) {
      let data = [...defectData];
      if (filters.customer && filters.customer !== 'All')
        data = data.filter(d => d.Customer === filters.customer);
      if (filters.plant && filters.plant !== 'All')
        data = data.filter(d => d.Plant === filters.plant);
      if (filters.lotType && filters.lotType !== 'All')
        data = data.filter(d => d.LotType === filters.lotType);
      if (filters.unitType)
        data = data.filter(d => d.UnitType === filters.unitType);
      if (filters.projectType && filters.projectType !== 'Overall')
        data = data.filter(d => d.ProjectType === filters.projectType);

      // Aggregate by defect code
      const codeMap = {};
      data.forEach(d => {
        if (!codeMap[d.DefectCode]) {
          codeMap[d.DefectCode] = {
            DefectCode: d.DefectCode,
            DefectName: d.DefectName,
            Department: d.Department,
            totalQty: 0,
            lossRatioSum: 0,
            count: 0,
          };
        }
        const c = codeMap[d.DefectCode];
        c.totalQty += d.DefectQty;
        c.lossRatioSum += d.LossRatio;
        c.count++;
      });

      const pareto = Object.values(codeMap)
        .map(c => ({
          DefectCode: c.DefectCode,
          DefectName: c.DefectName,
          Department: c.Department,
          TotalQty: c.totalQty,
          AvgLossRatio: Math.round((c.lossRatioSum / c.count) * 100) / 100,
        }))
        .sort((a, b) => b.AvgLossRatio - a.AvgLossRatio)
        .slice(0, 15);

      // Compute core loss ratio (top 3 codes)
      const totalLoss = pareto.reduce((s, p) => s + p.AvgLossRatio, 0);
      pareto.forEach((p, i) => {
        p.TotalLossRatio = Math.round((p.AvgLossRatio / totalLoss) * 100 * 100) / 100;
        p.CoreLossRatio = i < 3 ? p.TotalLossRatio : 0;
        if (i >= 3) {
          p.CoreLossRatio = 0;
        }
      });
      // Cumulative core for top codes
      let coreCum = 0;
      pareto.forEach(p => {
        if (p.CoreLossRatio > 0) {
          coreCum += p.CoreLossRatio;
        }
      });

      return { pareto, totalLoss: Math.round(totalLoss * 100) / 100 };
    },

    getDefectDetails(defectCode, filters = {}) {
      let data = defectData.filter(d => d.DefectCode === defectCode);
      if (filters.customer && filters.customer !== 'All')
        data = data.filter(d => d.Customer === filters.customer);
      if (filters.plant && filters.plant !== 'All')
        data = data.filter(d => d.Plant === filters.plant);

      // Trend
      const trend = weeks.map((week, i) => {
        const weekData = data.filter(d => d.ATSDate === week);
        const avgRatio = weekData.length > 0
          ? weekData.reduce((s, d) => s + d.LossRatio, 0) / weekData.length
          : 0;
        return {
          ATSDate: week,
          WeekLabel: weekLabels[i],
          LossRatio: Math.round(avgRatio * 100) / 100,
        };
      });

      // Department distribution
      const deptMap = {};
      data.forEach(d => {
        deptMap[d.Department] = (deptMap[d.Department] || 0) + d.DefectQty;
      });
      const departments = Object.entries(deptMap)
        .map(([dept, qty]) => ({ Department: dept, Qty: qty }))
        .sort((a, b) => b.Qty - a.Qty);

      const defectInfo = defectCodes.find(dc => dc.code === defectCode);

      return {
        defectCode,
        defectName: defectInfo ? defectInfo.name : defectCode,
        trend,
        departments,
      };
    },

    // Utility: get week info
    getWeekInfo(weekKey) {
      const idx = weeks.indexOf(weekKey);
      if (idx === -1) return null;
      return { key: weekKey, label: weekLabels[idx], date: weekDates[idx] };
    },

    getWeeks() {
      return weeks.map((w, i) => ({ key: w, label: weekLabels[i], date: weekDates[i] }));
    },

    getLastUpdated() {
      return '2026-05-24 08:30:00';
    },
  };

})();
