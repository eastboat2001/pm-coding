/**
 * QDM Finished Lot Yield Dashboard - Mock Data
 * Simulates API responses for the dashboard
 */

const MockData = {
    // Filter options
    filters: {
        customers: [
            { value: 'all', label: 'All Customers' },
            { value: 'customer_a', label: 'Customer A' },
            { value: 'customer_b', label: 'Customer B' },
            { value: 'customer_c', label: 'Customer C' },
            { value: 'customer_d', label: 'Customer D' },
            { value: 'customer_e', label: 'Customer E' }
        ],
        plants: [
            { value: 'all', label: 'All Plants' },
            { value: 'plant_1', label: 'Plant 1 - Shanghai' },
            { value: 'plant_2', label: 'Plant 2 - Suzhou' },
            { value: 'plant_3', label: 'Plant 3 - Shenzhen' }
        ],
        dateTypes: [
            { value: 'weekly', label: 'Weekly' },
            { value: 'monthly', label: 'Monthly' },
            { value: 'quarterly', label: 'Quarterly' }
        ],
        lotTypes: [
            { value: 'hvm', label: 'HVM' },
            { value: 'svm', label: 'SVM' },
            { value: 'pilot', label: 'Pilot' }
        ],
        unitTypes: [
            { value: 'nsqm', label: 'NSQM' },
            { value: 'nsom', label: 'NSOM' }
        ],
        projectTypes: [
            { value: 'overall', label: 'Overall' },
            { value: 'project_a', label: 'Project A' },
            { value: 'project_b', label: 'Project B' },
            { value: 'project_c', label: 'Project C' }
        ]
    },

    // Weekly yield summary data
    yieldSummary: [
        { week: '202612', yield: 96.12, target: 94.81, output: 142, input: 148, loss: 2.69, nsqmLoss: 1.98, nsomLoss: 0.71 },
        { week: '202613', yield: 96.35, target: 94.81, output: 155, input: 161, loss: 2.42, nsqmLoss: 1.82, nsomLoss: 0.60 },
        { week: '202614', yield: 96.08, target: 94.81, output: 138, input: 144, loss: 2.73, nsqmLoss: 2.05, nsomLoss: 0.68 },
        { week: '202615', yield: 96.52, target: 94.81, output: 161, input: 166, loss: 2.25, nsqmLoss: 1.68, nsomLoss: 0.57 },
        { week: '202616', yield: 96.78, target: 94.81, output: 168, input: 173, loss: 2.01, nsqmLoss: 1.51, nsomLoss: 0.50 },
        { week: '202617', yield: 96.45, target: 94.81, output: 152, input: 158, loss: 2.35, nsqmLoss: 1.76, nsomLoss: 0.59 },
        { week: '202618', yield: 96.92, target: 94.81, output: 175, input: 180, loss: 1.88, nsqmLoss: 1.41, nsomLoss: 0.47 },
        { week: '202619', yield: 96.68, target: 94.81, output: 163, input: 169, loss: 2.12, nsqmLoss: 1.59, nsomLoss: 0.53 },
        { week: '202620', yield: 97.15, target: 94.81, output: 182, input: 186, loss: 1.65, nsqmLoss: 1.24, nsomLoss: 0.41 },
        { week: '202621', yield: 96.83, target: 94.81, output: 159, input: 164, loss: 1.98, nsqmLoss: 1.48, nsomLoss: 0.50 }
    ],

    // Defect summary data (Pareto)
    defectSummary: [
        { code: 'ED25', name: 'Short in inner layer', totalRatio: 18.52, coreRatio: 12.35, qty: 245, trend: [12.1, 13.5, 14.2, 15.8, 16.2, 17.5, 18.5, 19.2, 18.8, 18.5] },
        { code: 'AP09', name: 'Component tilting', totalRatio: 14.28, coreRatio: 9.82, qty: 189, trend: [10.2, 11.5, 12.8, 13.5, 14.2, 14.8, 15.2, 14.8, 14.5, 14.3] },
        { code: 'GE01', name: 'Scratches', totalRatio: 11.65, coreRatio: 7.45, qty: 154, trend: [8.5, 9.2, 10.1, 10.8, 11.2, 11.5, 11.8, 11.6, 11.5, 11.7] },
        { code: 'VD12', name: 'Via void', totalRatio: 9.82, coreRatio: 6.28, qty: 130, trend: [6.8, 7.2, 7.8, 8.5, 9.2, 9.5, 9.8, 10.1, 9.9, 9.8] },
        { code: 'CL08', name: 'Copper residual', totalRatio: 8.45, coreRatio: 5.12, qty: 112, trend: [5.2, 5.8, 6.2, 6.8, 7.2, 7.8, 8.2, 8.5, 8.4, 8.5] },
        { code: 'DR03', name: 'Drill breakout', totalRatio: 7.18, coreRatio: 4.85, qty: 95, trend: [4.5, 5.0, 5.5, 6.0, 6.5, 6.8, 7.2, 7.5, 7.2, 7.2] },
        { code: 'SM15', name: 'Solder mask defect', totalRatio: 6.25, coreRatio: 3.92, qty: 83, trend: [3.8, 4.2, 4.8, 5.2, 5.5, 5.8, 6.2, 6.5, 6.3, 6.3] },
        { code: 'ET07', name: 'Etching defect', totalRatio: 5.82, coreRatio: 3.45, qty: 77, trend: [3.5, 3.8, 4.2, 4.5, 4.8, 5.2, 5.5, 5.8, 5.8, 5.8] },
        { code: 'PL11', name: 'Plating void', totalRatio: 4.95, coreRatio: 3.18, qty: 66, trend: [3.0, 3.2, 3.5, 3.8, 4.2, 4.5, 4.8, 5.0, 5.0, 5.0] },
        { code: 'AO22', name: 'AOI false call', totalRatio: 4.28, coreRatio: 2.85, qty: 57, trend: [2.5, 2.8, 3.0, 3.2, 3.5, 3.8, 4.0, 4.2, 4.3, 4.3] },
        { code: 'BN05', name: 'Bonding failure', totalRatio: 3.85, coreRatio: 2.52, qty: 51, trend: [2.2, 2.5, 2.8, 3.0, 3.2, 3.5, 3.8, 3.8, 3.8, 3.9] },
        { code: 'IN18', name: 'Insulation defect', totalRatio: 3.42, coreRatio: 2.15, qty: 45, trend: [2.0, 2.2, 2.5, 2.8, 3.0, 3.2, 3.4, 3.4, 3.4, 3.4] }
    ],

    // Department distribution for defect codes
    departmentDistribution: {
        'ED25': [
            { dept: 'Etching + AOI', ratio: 42.5 },
            { dept: 'Lamination', ratio: 28.3 },
            { dept: 'Drilling', ratio: 18.2 },
            { dept: 'Material', ratio: 11.0 }
        ],
        'AP09': [
            { dept: 'Assembly', ratio: 55.2 },
            { dept: 'SMT', ratio: 25.8 },
            { dept: 'Material', ratio: 19.0 }
        ],
        'GE01': [
            { dept: 'Handling', ratio: 38.5 },
            { dept: 'Etching + AOI', ratio: 32.2 },
            { dept: 'Plating', ratio: 29.3 }
        ],
        'VD12': [
            { dept: 'Drilling', ratio: 48.5 },
            { dept: 'Plating', ratio: 35.2 },
            { dept: 'Material', ratio: 16.3 }
        ],
        'CL08': [
            { dept: 'Etching + AOI', ratio: 52.8 },
            { dept: 'Lamination', ratio: 30.5 },
            { dept: 'Desmear', ratio: 16.7 }
        ],
        'DR03': [
            { dept: 'Drilling', ratio: 65.2 },
            { dept: 'Material', ratio: 22.8 },
            { dept: 'Lamination', ratio: 12.0 }
        ],
        'SM15': [
            { dept: 'Solder Mask', ratio: 58.5 },
            { dept: 'Etching + AOI', ratio: 28.2 },
            { dept: 'Handling', ratio: 13.3 }
        ],
        'ET07': [
            { dept: 'Etching + AOI', ratio: 72.5 },
            { dept: 'Plating', ratio: 27.5 }
        ],
        'PL11': [
            { dept: 'Plating', ratio: 68.2 },
            { dept: 'Drilling', ratio: 22.5 },
            { dept: 'Material', ratio: 9.3 }
        ],
        'AO22': [
            { dept: 'AOI', ratio: 85.2 },
            { dept: 'Etching', ratio: 14.8 }
        ],
        'BN05': [
            { dept: 'Assembly', ratio: 62.5 },
            { dept: 'SMT', ratio: 25.2 },
            { dept: 'Material', ratio: 12.3 }
        ],
        'IN18': [
            { dept: 'Lamination', ratio: 45.2 },
            { dept: 'Plating', ratio: 32.8 },
            { dept: 'Etching + AOI', ratio: 22.0 }
        ]
    },

    // Yield calculation breakdown
    yieldBreakdown: {
        processes: ['PAOI', 'E-test', 'CCAOI', 'Bump AOI', 'FVI', 'Inline', 'Others'],
        yields: [99.40, 99.50, 99.29, 99.38, 99.17, 99.49, 99.39]
    },

    // Last updated timestamp
    lastUpdated: '2026-05-28 08:30:00'
};

// Simulate API delay
function simulateDelay(ms = 300) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Mock API functions
const API = {
    async getFilters() {
        await simulateDelay(200);
        return { success: true, data: MockData.filters };
    },

    async getYieldSummary(filters = {}) {
        await simulateDelay(400);
        let data = [...MockData.yieldSummary];
        
        // Apply filter simulation (in real app, this would be server-side)
        if (filters.lotType && filters.lotType !== 'all') {
            data = data.map(d => ({
                ...d,
                yield: d.yield * (0.98 + Math.random() * 0.04),
                output: Math.floor(d.output * (0.9 + Math.random() * 0.2))
            }));
        }
        
        return { success: true, data };
    },

    async getDefectSummary(filters = {}) {
        await simulateDelay(400);
        let data = [...MockData.defectSummary];
        
        // Apply filter simulation
        if (filters.customer && filters.customer !== 'all') {
            data = data.map(d => ({
                ...d,
                totalRatio: d.totalRatio * (0.85 + Math.random() * 0.3),
                qty: Math.floor(d.qty * (0.8 + Math.random() * 0.4))
            }));
        }
        
        return { success: true, data };
    },

    async getDefectDetails(defectCode) {
        await simulateDelay(300);
        const defect = MockData.defectSummary.find(d => d.code === defectCode);
        const departments = MockData.departmentDistribution[defectCode] || [];
        
        if (!defect) {
            return { success: false, error: 'Defect code not found' };
        }
        
        return {
            success: true,
            data: {
                defect,
                departments,
                weeklyTrend: defect.trend
            }
        };
    },

    async getYieldBreakdown() {
        await simulateDelay(200);
        return { success: true, data: MockData.yieldBreakdown };
    },

    async getHealth() {
        return {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            dataFreshness: MockData.lastUpdated
        };
    }
};

// Export for use
if (typeof window !== 'undefined') {
    window.MockData = MockData;
    window.API = API;
}
