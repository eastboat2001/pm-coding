/**
 * QDM Finished Lot 良率看板 - 模拟数据
 * 基于 PRD 和设计文档创建的示例数据
 * 
 * 数据模型对应:
 *   DS-01 → MockData.yieldTrend (FinishedLotSummary)
 *   DS-02 → MockData.defectAnalysis (DefectSummary)
 */

const MockData = (() => {
    // ===== 筛选元数据 =====
    const filters = {
        customers: ['Intel', 'AMD', 'NVIDIA', 'Qualcomm', 'Broadcom', 'Texas Instruments'],
        plants: ['FAB1', 'FAB2', 'FAB3', 'OSAT1', 'OSAT2'],
        dateTypes: ['Weekly', 'Monthly', 'Quarterly'],
        lotTypes: ['All', 'HVM', 'EVT', 'DVT', 'PVT'],
        unitTypes: ['All', 'NSQM', 'NSOM'],
        projectTypes: ['Overall', 'Product A', 'Product B', 'Product C', 'Product D']
    };

    // ===== 缺陷代码库 =====
    const defectCodes = [
        { code: 'ED25', name: 'Etching Defect', department: 'Etching' },
        { code: 'AP09', name: 'Alignment Problem', department: 'Lithography' },
        { code: 'CD12', name: 'Contamination', department: 'Clean Room' },
        { code: 'PF05', name: 'Particle Failure', department: 'Deposition' },
        { code: 'MI18', name: 'Metallization Issue', department: 'Metallization' },
        { code: 'TS07', name: 'Thickness Variation', department: 'CMP' },
        { code: 'PR11', name: 'Photoresist Issue', department: 'Lithography' },
        { code: 'OX03', name: 'Oxide Defect', department: 'Oxidation' },
        { code: 'CT14', name: 'Contact Failure', department: 'Etching' },
        { code: 'GW08', name: 'Gate Width Issue', department: 'Lithography' }
    ];

    // ===== 生成12周良率趋势数据 (DS-01) =====
    const yieldTrend = [];
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 84); // 12周前

    let baseYield = 93.5;

    for (let i = 0; i < 12; i++) {
        const weekDate = new Date(startDate);
        weekDate.setDate(weekDate.getDate() + (i * 7));

        const weekLabel = 'W' + String(i + 1).padStart(2, '0');
        const dateStr = weekDate.toISOString().split('T')[0];

        // 良率：从93.5逐步改善到96.5左右，加随机波动
        baseYield += (Math.random() * 0.6 - 0.15);
        baseYield = Math.max(91, Math.min(98.5, baseYield));

        const targetYield = 96.5;
        const inputQty = 8000 + Math.floor(Math.random() * 4000);
        const outputNSQM = Math.floor(inputQty * (baseYield / 100));
        const finishedCount = Math.floor(outputNSQM * 0.98);
        const lossNSQM = inputQty - outputNSQM;

        // 每周生成缺陷数据
        const defects = defectCodes.map(dc => {
            const qty = Math.floor(Math.random() * 40) + 2;
            return {
                code: dc.code,
                name: dc.name,
                qty: qty,
                department: dc.department,
                lotType: 'HVM',
                unitType: 'NSQM',
                projectType: 'Overall'
            };
        });

        const totalDefectQty = defects.reduce((sum, d) => sum + d.qty, 0);

        defects.forEach(d => {
            d.lossRatio = totalDefectQty > 0 ? parseFloat((d.qty / totalDefectQty * 100).toFixed(2)) : 0;
            d.coreLossRatio = inputQty > 0 ? parseFloat((d.qty / inputQty * 100).toFixed(3)) : 0;
        });

        // 按损失占比降序
        defects.sort((a, b) => b.lossRatio - a.lossRatio);

        yieldTrend.push({
            week: weekLabel,
            date: dateStr,
            yield: parseFloat(baseYield.toFixed(2)),
            targetYield: targetYield,
            inputQty: inputQty,
            outputNSQM: outputNSQM,
            finishedCount: finishedCount,
            lossNSQM: lossNSQM,
            lotType: 'HVM',
            unitType: 'NSQM',
            projectType: 'Overall',
            defects: defects
        });
    }

    // ===== 缺陷分析数据 (DS-02) — 取最后一周 =====
    const lastWeek = yieldTrend[yieldTrend.length - 1];
    const defectAnalysis = lastWeek.defects;

    // ===== 责任部门分布 =====
    const departmentDistribution = [];
    const deptMap = {};
    defectAnalysis.forEach(d => {
        if (!deptMap[d.department]) deptMap[d.department] = 0;
        deptMap[d.department] += d.qty;
    });
    const totalDeptQty = Object.values(deptMap).reduce((a, b) => a + b, 0);
    Object.entries(deptMap)
        .map(([department, quantity]) => ({
            department,
            quantity,
            percentage: totalDeptQty > 0 ? parseFloat((quantity / totalDeptQty * 100).toFixed(2)) : 0
        }))
        .sort((a, b) => b.quantity - a.quantity)
        .forEach(item => departmentDistribution.push(item));

    // ===== 缺陷趋势数据（12周 × 3条主要缺陷） =====
    const defectTrend = [];
    const topDefectCodes = defectAnalysis.slice(0, 3).map(d => d.code);

    for (let i = 0; i < 12; i++) {
        const entry = { week: yieldTrend[i].week, date: yieldTrend[i].date };
        topDefectCodes.forEach(code => {
            const dc = defectCodes.find(x => x.code === code);
            entry[code] = dc
                ? Math.floor(Math.random() * 35) + 5
                : Math.floor(Math.random() * 20) + 3;
        });
        defectTrend.push(entry);
    }

    // ===== 对外暴露 =====
    return {
        filters,
        yieldTrend,
        defectAnalysis,
        departmentDistribution,
        defectTrend,
        defectCodes
    };
})();
