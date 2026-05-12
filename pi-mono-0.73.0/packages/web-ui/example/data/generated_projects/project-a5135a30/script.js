/**
 * 个人备忘录日历 - 主逻辑文件
 * 版本：1.0.0
 */

// 全局变量
let currentYear;
let currentMonth;
let currentDate;

// DOM 元素引用
const yearSelect = document.getElementById('year-select');
const monthSelect = document.getElementById('month-select');
const todayBtn = document.getElementById('today-btn');
const calendarGrid = document.getElementById('calendar-grid');
const currentDateDisplay = document.getElementById('current-date-display');
const memoModal = document.getElementById('memo-modal');
const modalDateTitle = document.getElementById('modal-date-title');
const memoTextarea = document.getElementById('memo-textarea');
const memoSaveBtn = document.getElementById('memo-save');
const memoDeleteBtn = document.getElementById('memo-delete');
const modalCloseBtn = document.getElementById('modal-close');
const modalOverlay = document.querySelector('.modal-overlay');

// 当前编辑的日期
let editingDate = null;

/**
 * 初始化函数
 */
function init() {
    // 获取当前日期
    const today = new Date();
    currentYear = today.getFullYear();
    currentMonth = today.getMonth() + 1; // 月份从1开始
    currentDate = today;
    
    // 初始化下拉框
    initYearDropdown();
    initMonthDropdown();
    
    // 渲染日历
    renderCalendar(currentYear, currentMonth);
    
    // 绑定事件
    bindEvents();
    
    // 更新当前日期显示
    updateCurrentDateDisplay();
}

/**
 * 初始化年份下拉框（当前年 ±10年）
 */
function initYearDropdown() {
    const currentYearValue = new Date().getFullYear();
    const startYear = currentYearValue - 10;
    const endYear = currentYearValue + 10;
    
    yearSelect.innerHTML = '';
    
    for (let year = startYear; year <= endYear; year++) {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = `${year}年`;
        yearSelect.appendChild(option);
    }
    
    // 设置默认选中值
    yearSelect.value = currentYear;
}

/**
 * 初始化月份下拉框
 */
function initMonthDropdown() {
    monthSelect.value = currentMonth;
}

/**
 * 渲染日历
 * @param {number} year - 年份
 * @param {number} month - 月份（1-12）
 */
function renderCalendar(year, month) {
    // 清空日历网格
    calendarGrid.innerHTML = '';
    
    // 计算当月第一天是星期几（0-6，0表示周日）
    const firstDay = new Date(year, month - 1, 1).getDay();
    
    // 调整为以周一开始（0表示周一，6表示周日）
    const firstDayAdjusted = firstDay === 0 ? 6 : firstDay - 1;
    
    // 计算当月天数
    const daysInMonth = getDaysInMonth(year, month);
    
    // 计算上个月天数（用于显示上个月的日期）
    const daysInPrevMonth = getDaysInMonth(year, month === 1 ? 12 : month - 1);
    
    // 计算总格子数（确保是7的倍数）
    const totalCells = Math.ceil((firstDayAdjusted + daysInMonth) / 7) * 7;
    
    // 生成日历格子
    for (let i = 0; i < totalCells; i++) {
        const dayCell = document.createElement('div');
        dayCell.classList.add('day-cell');
        
        let dateStr;
        let dayNumber;
        let isCurrentMonth = true;
        
        if (i < firstDayAdjusted) {
            // 上个月的日期
            dayNumber = daysInPrevMonth - firstDayAdjusted + i + 1;
            const prevMonth = month === 1 ? 12 : month - 1;
            const prevYear = month === 1 ? year - 1 : year;
            dateStr = formatDate(prevYear, prevMonth, dayNumber);
            isCurrentMonth = false;
        } else if (i < firstDayAdjusted + daysInMonth) {
            // 当月的日期
            dayNumber = i - firstDayAdjusted + 1;
            dateStr = formatDate(year, month, dayNumber);
        } else {
            // 下个月的日期
            dayNumber = i - firstDayAdjusted - daysInMonth + 1;
            const nextMonth = month === 12 ? 1 : month + 1;
            const nextYear = month === 12 ? year + 1 : year;
            dateStr = formatDate(nextYear, nextMonth, dayNumber);
            isCurrentMonth = false;
        }
        
        // 设置日期文本
        dayCell.textContent = dayNumber;
        dayCell.dataset.date = dateStr;
        
        // 添加非当月样式
        if (!isCurrentMonth) {
            dayCell.classList.add('other-month');
        }
        
        // 检查是否是今天
        if (isToday(dateStr)) {
            dayCell.classList.add('today');
        }
        
        // 检查是否有备忘内容
        const memoContent = getMemo(dateStr);
        if (memoContent) {
            dayCell.classList.add('has-content');
        }
        
        // 添加点击事件
        dayCell.addEventListener('click', () => openMemoModal(dateStr));
        
        calendarGrid.appendChild(dayCell);
    }
}

/**
 * 获取指定年月的天数
 * @param {number} year - 年份
 * @param {number} month - 月份（1-12）
 * @returns {number} 天数
 */
function getDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

/**
 * 格式化日期为 YYYY-MM-DD
 * @param {number} year - 年份
 * @param {number} month - 月份（1-12）
 * @param {number} day - 日期
 * @returns {string} 格式化的日期字符串
 */
function formatDate(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 检查日期字符串是否是今天
 * @param {string} dateStr - 日期字符串 YYYY-MM-DD
 * @returns {boolean} 是否是今天
 */
function isToday(dateStr) {
    const today = new Date();
    const todayStr = formatDate(today.getFullYear(), today.getMonth() + 1, today.getDate());
    return dateStr === todayStr;
}

/**
 * 更新当前日期显示
 */
function updateCurrentDateDisplay() {
    const options = { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric',
        weekday: 'long'
    };
    currentDateDisplay.textContent = currentDate.toLocaleDateString('zh-CN', options);
}

/**
 * 打开备忘录模态框
 * @param {string} dateStr - 日期字符串 YYYY-MM-DD
 */
function openMemoModal(dateStr) {
    editingDate = dateStr;
    
    // 设置模态框标题
    const date = new Date(dateStr);
    const options = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
    modalDateTitle.textContent = date.toLocaleDateString('zh-CN', options);
    
    // 加载备忘内容
    const memoContent = getMemo(dateStr);
    memoTextarea.value = memoContent || '';
    
    // 显示模态框
    memoModal.classList.add('active');
    document.body.style.overflow = 'hidden'; // 防止背景滚动
}

/**
 * 关闭备忘录模态框
 */
function closeMemoModal() {
    memoModal.classList.remove('active');
    document.body.style.overflow = ''; // 恢复背景滚动
    editingDate = null;
}

/**
 * 保存备忘录
 */
function saveMemo() {
    if (!editingDate) return;
    
    const content = memoTextarea.value.trim();
    
    if (content) {
        saveMemoToStorage(editingDate, content);
    } else {
        // 如果内容为空，则删除备忘
        deleteMemoFromStorage(editingDate);
    }
    
    // 关闭模态框
    closeMemoModal();
    
    // 重新渲染日历以更新背景色
    renderCalendar(currentYear, currentMonth);
}

/**
 * 删除备忘录
 */
function deleteMemo() {
    if (!editingDate) return;
    
    // 从 LocalStorage 中删除
    deleteMemoFromStorage(editingDate);
    
    // 关闭模态框
    closeMemoModal();
    
    // 重新渲染日历以更新背景色
    renderCalendar(currentYear, currentMonth);
}

/**
 * 绑定事件监听器
 */
function bindEvents() {
    // 年份下拉框改变事件
    yearSelect.addEventListener('change', (e) => {
        currentYear = parseInt(e.target.value);
        renderCalendar(currentYear, currentMonth);
    });
    
    // 月份下拉框改变事件
    monthSelect.addEventListener('change', (e) => {
        currentMonth = parseInt(e.target.value);
        renderCalendar(currentYear, currentMonth);
    });
    
    // 回到今天按钮
    todayBtn.addEventListener('click', () => {
        const today = new Date();
        currentYear = today.getFullYear();
        currentMonth = today.getMonth() + 1;
        currentDate = today;
        
        // 更新下拉框值
        yearSelect.value = currentYear;
        monthSelect.value = currentMonth;
        
        // 重新渲染日历
        renderCalendar(currentYear, currentMonth);
        updateCurrentDateDisplay();
    });
    
    // 模态框关闭按钮
    modalCloseBtn.addEventListener('click', closeMemoModal);
    
    // 模态框遮罩层点击关闭
    modalOverlay.addEventListener('click', closeMemoModal);
    
    // 保存按钮
    memoSaveBtn.addEventListener('click', saveMemo);
    
    // 删除按钮
    memoDeleteBtn.addEventListener('click', deleteMemo);
    
    // ESC 键关闭模态框
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && memoModal.classList.contains('active')) {
            closeMemoModal();
        }
    });
}

// LocalStorage 操作封装

/**
 * 获取指定日期的备忘录
 * @param {string} dateStr - 日期字符串 YYYY-MM-DD
 * @returns {string|null} 备忘录内容
 */
function getMemo(dateStr) {
    try {
        const key = `memo_${dateStr}`;
        return localStorage.getItem(key);
    } catch (error) {
        console.error('获取备忘录失败:', error);
        return null;
    }
}

/**
 * 保存备忘录到 LocalStorage
 * @param {string} dateStr - 日期字符串 YYYY-MM-DD
 * @param {string} content - 备忘录内容
 */
function saveMemoToStorage(dateStr, content) {
    try {
        const key = `memo_${dateStr}`;
        localStorage.setItem(key, content);
    } catch (error) {
        console.error('保存备忘录失败:', error);
        alert('本地存储不可用，数据将无法持久化');
    }
}

/**
 * 从 LocalStorage 删除备忘录
 * @param {string} dateStr - 日期字符串 YYYY-MM-DD
 */
function deleteMemoFromStorage(dateStr) {
    try {
        const key = `memo_${dateStr}`;
        localStorage.removeItem(key);
    } catch (error) {
        console.error('删除备忘录失败:', error);
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', init);