/**
 * QDM Finished Lot Yield Dashboard — Mock Data
 * Realistic manufacturing data for demo/preview
 */
const DashboardData = (() => {
  // Filter Options
  const customers = [
    { id: 'ALL', label: 'All Selected' },
    { id: 'CUS-A01', label: 'Alpha Semiconductor' },
    { id: 'CUS-B02', label: 'Beta Microelectronics' },
    { id: 'CUS-C03', label: 'CoreLogic IC' },
    { id: 'CUS-D04', label: 'Delta Photonics' },
    { id: 'CUS-E05', label: 'Epsilon Devices' },
    { id: 'CUS-F06', label: 'Frontier Systems' }
  ];

  const plants = [
    { id: 'ALL', label: 'All Selected' },
    { id: 'PLT-SZ', label: 'Shenzhen Plant' },
    { id: 'PLT-GZ', label: 'Guangzhou Plant' },
    { id: 'PLT-SH', label: 'Shanghai Plant' },
    { id: 'PLT-BJ', label: 'Beijing Plant' }
  ];

  const dateTypes = [
    { id: 'Weekly', label: 'Weekly' },
    { id: 'Monthly', label: 'Monthly' },
    { id: 'Quarterly', label: 'Quarterly' }
  ];

  const lotTypes = [
    { id: 'HVM', label: 'HVM' },
    { id: 'NPI', label: 'NPI' },
    { id: 'Pilot', label: 'Pilot' }
  ];

  const unitTypes = [
    { id: 'NSQM', label: 'NSQM' },
    { id: 'NSOM', label: 'NSOM' }
  ];

  const projectTypes = [
    { id: 'Overall', label: 'Overall' },
    { id: 'New', label: 'New Project' },
    { id: 'Legacy', label: 'Legacy' }
  ];

  // Weekly Summary Data (DS-01)
  const weeklySummary = [
    { week: '2026W09', label: 'W09', yield: 95.12, target: 94.81, output: 142, input: 149, lossNSQM: 6.93 },
    { week: '2026W10', label: 'W10', yield: 95.45, target: 94.81, output: 148, input: 155, lossNSQM: 6.71 },
    { week: '2026W11', label: 'W11', yield: 95.28, target: 94.81, output: 145, input: 152, lossNSQM: 6.94 },
    { week: '2026W12', label: 'W12', yield: 95.73, target: 94.81, output: 151, input: 158, lossNSQM: 6.55 },
    { week: '2026W13', label: 'W13', yield: 95.91, target: 94.81, output: 153, input: 160, lossNSQM: 6.39 },
    { week: '2026W14', label: 'W14', yield: 96.05, target: 94.81, output: 155, input: 161, lossNSQM: 6.25 },
    { week: '2026W15', label: 'W15', yield: 95.68, target: 94.81, output: 150, input: 157, lossNSQM: 6.65 },
    { week: '2026W16', label: 'W16', yield: 96.22, target: 94.81, output: 157, input: 163, lossNSQM: 6.07 },
    { week: '2026W17', label: 'W17', yield: 96.41, target: 94.81, output: 160, input: 166, lossNSQM: 5.92 },
    { week: '2026W18', label: 'W18', yield: 96.15, target: 94.81, output: 156, input: 162, lossNSQM: 6.19 },
    { week: '2026W19', label: 'W19', yield: 96.53, target: 94.81, output: 162, input: 168, lossNSQM: 5.78 },
    { week: '2026W20', label: 'W20', yield: 96.83, target: 94.81, output: 159, input: 164, lossNSQM: 5.44 }
  ];

  // Defect Summary Data (DS-02) — Top 15 codes
  const defectCodes = [
    { code: 'ED25', name: 'Short in inner layer', dept: 'Etching + AOI', totalLoss: 0.48, coreLoss: 0.31 },
    { code: 'AP09', name: 'Component tilting', dept: 'Assembly', totalLoss: 0.42, coreLoss: 0.28 },
    { code: 'GE01', name: 'Scratches', dept: 'Material', totalLoss: 0.38, coreLoss: 0.22 },
    { code: 'CF12', name: 'Solder bridging', dept: 'Assembly', totalLoss: 0.35, coreLoss: 0.24 },
    { code: 'LD04', name: 'Laser drill offset', dept: 'Drilling', totalLoss: 0.31, coreLoss: 0.19 },
    { code: 'PL08', name: 'Plating void', dept: 'Plating', totalLoss: 0.29, coreLoss: 0.17 },
    { code: 'BW03', name: 'Bow & twist OOS', dept: 'Lamination', totalLoss: 0.27, coreLoss: 0.15 },
    { code: 'DR11', name: 'Dry-film adhesion fail', dept: 'Etching + AOI', totalLoss: 0.24, coreLoss: 0.14 },
    { code: 'SM06', name: 'Solder mask registration', dept: 'Lithography', totalLoss: 0.22, coreLoss: 0.12 },
    { code: 'TE02', name: 'Test fail — open', dept: 'E-Test', totalLoss: 0.20, coreLoss: 0.11 },
    { code: 'AO17', name: 'AOI false call escape', dept: 'Etching + AOI', totalLoss: 0.18, coreLoss: 0.10 },
    { code: 'CL09', name: 'Cleaning residue', dept: 'Chemical', totalLoss: 0.16, coreLoss: 0.08 },
    { code: 'FN05', name: 'Final inspection mark', dept: 'FVI', totalLoss: 0.14, coreLoss: 0.07 },
    { code: 'PC14', name: 'PTH crack', dept: 'Drilling', totalLoss: 0.12, coreLoss: 0.06 },
    { code: 'OX21', name: 'Oxide removal incomplete', dept: 'Chemical', totalLoss: 0.10, coreLoss: 0.04 }
  ];

  // Department distribution for drill-down donut chart
  const departments = [
    { name: 'Etching + AOI', color: '#2563eb' },
    { name: 'Assembly', color: '#60a5fa' },
    { name: 'Material', color: '#93c5fd' },
    { name: 'Drilling', color: '#bfdbfe' },
    { name: 'Plating', color: '#dbeafe' },
    { name: 'Lamination', color: '#424a55' },
    { name: 'Lithography', color: '#647280' },
    { name: 'E-Test', color: '#9ca3af' },
    { name: 'Chemical', color: '#d1d5db' },
    { name: 'FVI', color: '#f3f4f6' }
  ];

  // Simulated defect weekly trend for drill-down (one code)
  function getDefectTrend(code) {
    const seed = code.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const base = defectCodes.find(d => d.code === code);
    if (!base) return [];

    return weeklySummary.map((w, i) => {
      const variance = Math.sin(seed + i * 0.7) * 0.06;
      return {
        week: w.label,
        qty: Math.max(1, Math.round((base.totalLoss * 12) + variance * 10))
      };
    });
  }

  // Department breakdown for a defect code
  function getDeptBreakdown(code) {
    const base = defectCodes.find(d => d.code === code);
    if (!base) return [];
    const targetDept = base.dept;
    return departments.map(d => {
      let value;
      if (d.name === targetDept) {
        value = Math.round(base.totalLoss * 100 * 0.35);
      } else {
        value = Math.round(base.totalLoss * 100 * (0.05 + Math.random() * 0.12));
      }
      return { name: d.name, value: Math.max(1, value), color: d.color };
    }).filter(d => d.value > 1).sort((a, b) => b.value - a.value);
  }

  // Public API
  return {
    filters: { customers, plants, dateTypes, lotTypes, unitTypes, projectTypes },
    weeklySummary,
    defectCodes,
    getDefectTrend,
    getDeptBreakdown,
    lastUpdated: '2026-06-11 06:30 (UTC+8)'
  };
})();
