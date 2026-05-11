/**
 * 个人备忘录日历 - 主逻辑
 * 版本: 1.0.0
 * 说明: 纯静态日历备忘录应用，使用 LocalStorage 存储数据
 */

// ==================== 常量定义 ====================
const STORAGE_KEY_PREFIX = 'memo_';
const YEAR_RANGE = 10; // 年份下拉框范围：当前年 ±10年

// ==================== DOM 元素引用 ====================
const yearSelect = document.getElementById('yearSelect');
const monthSelect = document.getElementById('monthSelect');
const todayBtn = document.getElementById('todayBtn');
const calendarGrid = document.getElementById('calendarGrid');
const memoModal = document.getElementById('memoModal');
const modalTitle = document.getElementById('modalTitle');
const memoText = document.getElementById('memoText');
const saveMemoBtn = document.getElementById('saveMemo');
const deleteMemoBtn = document.getElementById('deleteMemo');
const closeModalBtn = document.getElementById('closeModal');
const storageWarning = document.getElementById('storageWarning');

// ==================== 状态管理 ====================
let currentDate = new Date();
let selectedYear = currentDate.getFullYear();
let selectedMonth = currentDate.getMonth() + 1; // 1-12
let selectedDateStr = null; // 当前编辑的日期字符串

// ==================== 存储管理模块 ====================

/**
 * 检查 LocalStorage 是否可用
 * @returns {boolean}
 */
function isLocalStorageAvailable() {
    try {
        const testKey = '__test__';
        localStorage.setItem(testKey, testKey);
        localStorage.removeItem(testKey);
        return true;
    } catch (e) {
        console.error('LocalStorage 不可用:', e);
        return false;
    }
}

/**
 * 获取指定日期的存储 Key
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {string}
 */
function getStorageKey(year, month, day) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return `${STORAGE_KEY_PREFIX}${dateStr}`;
}

/**
 * 获取备忘录内容
 * @param {string} dateStr - 格式: YYYY-MM-DD
 * @returns {string|null}
 */
function getMemo(dateStr) {
    try {
        const key = `${STORAGE_KEY_PREFIX}${dateStr}`;
        return localStorage.getItem(key);
    } catch (e) {
        console.error('读取备忘录失败:', e);
        return null;
    }
}

/**
 * 保存备忘录内容
 * @param {string} dateStr - 格式: YYYY-MM-DD
 * @param {string} text - 备忘内容
 * @returns {boolean}
 */
function saveMemo(dateStr, text) {
    try {
        if (!isLocalStorageAvailable()) {
            showStorageWarning();
            return false;
        }
        const key = `${STORAGE_KEY_PREFIX}${dateStr}`;
        localStorage.setItem(key, text);
        return true;
    } catch (e) {
        console.error('保存备忘录失败:', e);
        showStorageWarning();
        return false;
    }
}

/**
 * 删除备忘录
 * @param {string} dateStr - 格式: YYYY-MM-DD
 * @returns {boolean}
 */
function deleteMemo(dateStr) {
    try {
        const key = `${STORAGE_KEY_PREFIX}${dateStr}`;
        localStorage.removeItem(key);
        return true;
    } catch (e) {
        console.error('删除备忘录失败:', e);
        return false;
    }
}

/**
 * 检查指定日期是否有备忘录
 * @param {string} dateStr - 格式: YYYY-MM-DD
 * @returns {boolean}
 */
function hasMemo(dateStr) {
    const memo = getMemo(dateStr);
    return memo !== null && memo.trim().length > 0;
}

// ==================== 日历核心模块 ====================

/**
 * 初始化年份下拉框
 */
function initYearDropdown() {
    const currentYear = new Date().getFullYear();
    const startYear = currentYear - YEAR_RANGE;
    const endYear = currentYear + YEAR_RANGE;

    yearSelect.innerHTML = '';
    for (let year = startYear; year <= endYear; year++) {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = `${year}年`;
        if (year === selectedYear) {
            option.selected = true;
        }
        yearSelect.appendChild(option);
    }
}

/**
 * 初始化月份下拉框
 */
function initMonthDropdown() {
    monthSelect.value = selectedMonth;
}

/**
 * 获取指定月份的天数
 * @param {number} year
 * @param {number} month - 1-12
 * @returns {number}
 */
function getDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

/**
 * 获取指定月份第一天是星期几（0=周一，1=周二，...6=周日）
 * @param {number} year
 * @param {number} month - 1-12
 * @returns {number}
 */
function getFirstDayOfMonth(year, month) {
    const day = new Date(year, month - 1, 1).getDay();
    // 转换为周一=0, 周日=6 的格式
    // 0=周日, 1=周一, 2=周二, 3=周三, 4=周四, 5=周五, 6=周六
    // 转换为: 0=周一, 1=周二, 2=周三, 3=周四, 4=周五, 5=周六, 6=周日
    return day === 0 ? 6 : day - 1;
}

/**
 * 判断是否是今天
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {boolean}
 */
function isToday(year, month, day) {
    const today = new Date();
    return today.getFullYear() === year &&
           today.getMonth() + 1 === month &&
           today.getDate() === day;
}

/**
 * 生成日期字符串
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {string} - 格式: YYYY-MM-DD
 */
function formatDateStr(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 渲染日历
 * @param {number} year
 * @param {number} month - 1-12
 */
function renderCalendar(year, month) {
    // 清空日历网格
    calendarGrid.innerHTML = '';

    // 获取当月信息
    const daysInMonth = getDaysInMonth(year, month);
    const firstDay = getFirstDayOfMonth(year, month);

    // 添加空白天数（月初之前的偏移）
    for (let i = 0; i < firstDay; i++) {
        const emptyCell = document.createElement('div');
        emptyCell.className = 'day-cell empty';
        calendarGrid.appendChild(emptyCell);
    }

    // 添加日期格子
    for (let day = 1; day <= daysInMonth; day++) {
        const dayCell = document.createElement('div');
        dayCell.className = 'day-cell';
        dayCell.textContent = day;

        const dateStr = formatDateStr(year, month, day);

        // 检查是否是今天
        if (isToday(year, month, day)) {
            dayCell.classList.add('today');
        }

        // 检查是否有备忘录
        if (hasMemo(dateStr)) {
            dayCell.classList.add('has-memo');
        }

        // 添加点击事件
        dayCell.addEventListener('click', () => {
            openMemoModal(dateStr);
        });

        // 存储日期信息用于后续更新
        dayCell.dataset.date = dateStr;

        calendarGrid.appendChild(dayCell);
    }
}

// ==================== 弹窗交互模块 ====================

/**
 * 打开备忘录编辑弹窗
 * @param {string} dateStr - 格式: YYYY-MM-DD
 */
function openMemoModal(dateStr) {
    selectedDateStr = dateStr;

    // 设置标题
    modalTitle.textContent = `备忘录 - ${dateStr}`;

    // 加载已有内容
    const existingMemo = getMemo(dateStr);
    memoText.value = existingMemo || '';

    // 显示弹窗
    memoModal.classList.add('active');

    // 聚焦文本框
    memoText.focus();

    // 禁止背景滚动
    document.body.style.overflow = 'hidden';
}

/**
 * 关闭弹窗
 */
function closeModal() {
    memoModal.classList.remove('active');
    selectedDateStr = null;
    memoText.value = '';

    // 恢复背景滚动
    document.body.style.overflow = '';
}

/**
 * 保存备忘录
 */
function handleSaveMemo() {
    if (!selectedDateStr) return;

    const text = memoText.value;
    const success = saveMemo(selectedDateStr, text);

    if (success) {
        closeModal();
        renderCalendar(selectedYear, selectedMonth);
    }
}

/**
 * 删除备忘录
 */
function handleDeleteMemo() {
    if (!selectedDateStr) return;

    const success = deleteMemo(selectedDateStr);

    if (success) {
        closeModal();
        renderCalendar(selectedYear, selectedMonth);
    }
}

/**
 * 显示存储警告
 */
function showStorageWarning() {
    storageWarning.classList.remove('hidden');
    setTimeout(() => {
        storageWarning.classList.add('hidden');
    }, 3000);
}

// ==================== 事件绑定模块 ====================

/**
 * 绑定所有事件监听器
 */
function bindEvents() {
    // 年份下拉框改变
    yearSelect.addEventListener('change', (e) => {
        selectedYear = parseInt(e.target.value);
        renderCalendar(selectedYear, selectedMonth);
    });

    // 月份下拉框改变
    monthSelect.addEventListener('change', (e) => {
        selectedMonth = parseInt(e.target.value);
        renderCalendar(selectedYear, selectedMonth);
    });

    // 回到今天按钮
    todayBtn.addEventListener('click', () => {
        const today = new Date();
        selectedYear = today.getFullYear();
        selectedMonth = today.getMonth() + 1;

        // 更新下拉框选中状态
        yearSelect.value = selectedYear;
        monthSelect.value = selectedMonth;

        renderCalendar(selectedYear, selectedMonth);
    });

    // 保存按钮
    saveMemoBtn.addEventListener('click', handleSaveMemo);

    // 删除按钮
    deleteMemoBtn.addEventListener('click', handleDeleteMemo);

    // 关闭按钮
    closeModalBtn.addEventListener('click', closeModal);

    // 点击遮罩层关闭
    memoModal.addEventListener('click', (e) => {
        if (e.target === memoModal) {
            closeModal();
        }
    });

    // ESC 键关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && memoModal.classList.contains('active')) {
            closeModal();
        }
    });
}

// ==================== 初始化 ====================

/**
 * 应用初始化
 */
function init() {
    // 检查存储可用性
    if (!isLocalStorageAvailable()) {
        showStorageWarning();
    }

    // 初始化下拉框
    initYearDropdown();
    initMonthDropdown();

    // 绑定事件
    bindEvents();

    // 渲染初始日历
    renderCalendar(selectedYear, selectedMonth);

    console.log('个人备忘录日历初始化完成');
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
