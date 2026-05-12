<template>
  <div class="space-y-6">
    <!-- Header with filters and stats -->
    <div class="bg-white shadow rounded-lg p-6">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6">
        <h2 class="text-lg font-medium text-gray-900 mb-4 sm:mb-0">收支记录</h2>
        <button
          @click="openRecordModal()"
          class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          新增记录
        </button>
      </div>

      <!-- Filters -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">月份</label>
          <select
            v-model="filters.month"
            @change="fetchRecords"
            class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          >
            <option value="">全部</option>
            <option v-for="month in availableMonths" :key="month" :value="month">
              {{ month }}
            </option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">分类</label>
          <select
            v-model="filters.category_id"
            @change="fetchRecords"
            class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          >
            <option value="">全部</option>
            <option v-for="category in categories" :key="category.id" :value="category.id">
              {{ category.name }}
            </option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">类型</label>
          <select
            v-model="filters.type"
            @change="fetchRecords"
            class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          >
            <option value="">全部</option>
            <option value="income">收入</option>
            <option value="expense">支出</option>
          </select>
        </div>
      </div>

      <!-- Statistics -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="bg-green-50 rounded-lg p-4">
          <div class="text-sm text-green-600 font-medium">总收入</div>
          <div class="text-2xl font-bold text-green-700">
            ¥{{ formatAmount(statistics.total_income) }}
          </div>
        </div>
        <div class="bg-red-50 rounded-lg p-4">
          <div class="text-sm text-red-600 font-medium">总支出</div>
          <div class="text-2xl font-bold text-red-700">
            ¥{{ formatAmount(statistics.total_expense) }}
          </div>
        </div>
        <div class="bg-blue-50 rounded-lg p-4">
          <div class="text-sm text-blue-600 font-medium">结余</div>
          <div class="text-2xl font-bold" :class="statistics.balance >= 0 ? 'text-blue-700' : 'text-red-700'">
            ¥{{ formatAmount(statistics.balance) }}
          </div>
        </div>
      </div>
    </div>

    <!-- Records List -->
    <div class="bg-white shadow rounded-lg overflow-hidden">
      <div class="px-6 py-4 border-b border-gray-200">
        <h3 class="text-lg font-medium text-gray-900">历史记录</h3>
      </div>
      <div class="overflow-x-auto">
        <table class="min-w-full divide-y divide-gray-200">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                日期
              </th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                类型
              </th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                金额
              </th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                分类
              </th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                支付方式
              </th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                备注
              </th>
              <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                操作
              </th>
            </tr>
          </thead>
          <tbody class="bg-white divide-y divide-gray-200">
            <tr v-if="records.length === 0">
              <td colspan="7" class="px-6 py-12 text-center text-gray-500">
                暂无记录
              </td>
            </tr>
            <tr v-for="record in records" :key="record.id">
              <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                {{ record.date }}
              </td>
              <td class="px-6 py-4 whitespace-nowrap">
                <span
                  :class="[
                    'px-2 inline-flex text-xs leading-5 font-semibold rounded-full',
                    record.type === 'income' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  ]"
                >
                  {{ record.type === 'income' ? '收入' : '支出' }}
                </span>
              </td>
              <td class="px-6 py-4 whitespace-nowrap text-sm font-medium" :class="record.type === 'income' ? 'text-green-600' : 'text-red-600'">
                {{ record.type === 'income' ? '+' : '-' }}¥{{ formatAmount(record.amount) }}
              </td>
              <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                {{ record.category_name || '-' }}
              </td>
              <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                {{ record.method_name || '-' }}
              </td>
              <td class="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">
                {{ record.note || '-' }}
              </td>
              <td class="px-6 py-4 whitespace-nowrap text-sm font-medium">
                <button
                  @click="openRecordModal(record)"
                  class="text-indigo-600 hover:text-indigo-900 mr-3"
                >
                  编辑
                </button>
                <button
                  @click="confirmDelete(record)"
                  class="text-red-600 hover:text-red-900"
                >
                  删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Record Modal -->
    <div v-if="showRecordModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        <div class="fixed inset-0 transition-opacity" @click="closeRecordModal">
          <div class="absolute inset-0 bg-gray-500 opacity-75"></div>
        </div>

        <span class="hidden sm:inline-block sm:align-middle sm:h-screen">&#8203;</span>

        <div
          class="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full"
        >
          <div class="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
            <h3 class="text-lg leading-6 font-medium text-gray-900 mb-4">
              {{ editingRecord ? '编辑记录' : '新增记录' }}
            </h3>
            <form @submit.prevent="submitRecord">
              <div class="grid grid-cols-1 gap-4">
                <!-- Type -->
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">
                    账目类型 <span class="text-red-500">*</span>
                  </label>
                  <select
                    v-model="recordForm.type"
                    required
                    class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  >
                    <option value="expense">支出</option>
                    <option value="income">收入</option>
                  </select>
                </div>

                <!-- Amount -->
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">
                    金额 <span class="text-red-500">*</span>
                  </label>
                  <input
                    v-model="recordForm.amount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                    placeholder="请输入金额"
                  />
                </div>

                <!-- Date -->
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">
                    日期 <span class="text-red-500">*</span>
                  </label>
                  <input
                    v-model="recordForm.date"
                    type="date"
                    required
                    class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  />
                </div>

                <!-- Category -->
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">分类</label>
                  <select
                    v-model="recordForm.category_id"
                    class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  >
                    <option :value="null">无</option>
                    <option
                      v-for="category in filteredCategories"
                      :key="category.id"
                      :value="category.id"
                    >
                      {{ category.name }}
                    </option>
                  </select>
                </div>

                <!-- Payment Method -->
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">支付方式</label>
                  <select
                    v-model="recordForm.method_id"
                    class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  >
                    <option :value="null">无</option>
                    <option
                      v-for="method in paymentMethods"
                      :key="method.id"
                      :value="method.id"
                    >
                      {{ method.name }}
                    </option>
                  </select>
                </div>

                <!-- Note -->
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">备注</label>
                  <textarea
                    v-model="recordForm.note"
                    rows="2"
                    class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                    placeholder="选填备注信息"
                  ></textarea>
                </div>
              </div>

              <!-- Error message -->
              <div v-if="recordError" class="mt-4 text-sm text-red-600">
                {{ recordError }}
              </div>

              <div class="mt-6 flex justify-end space-x-3">
                <button
                  type="button"
                  @click="closeRecordModal"
                  class="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  取消
                </button>
                <button
                  type="submit"
                  :disabled="submitting"
                  class="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                  {{ submitting ? '提交中...' : '提交' }}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>

    <!-- Delete Confirmation Modal -->
    <div v-if="showDeleteModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        <div class="fixed inset-0 transition-opacity" @click="closeDeleteModal">
          <div class="absolute inset-0 bg-gray-500 opacity-75"></div>
        </div>

        <span class="hidden sm:inline-block sm:align-middle sm:h-screen">&#8203;</span>

        <div
          class="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full"
        >
          <div class="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
            <div class="sm:flex sm:items-start">
              <div class="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
                <svg class="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div class="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
                <h3 class="text-lg leading-6 font-medium text-gray-900">确认删除</h3>
                <div class="mt-2">
                  <p class="text-sm text-gray-500">确认删除该笔记录吗？此操作无法撤销。</p>
                </div>
              </div>
            </div>
          </div>
          <div class="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
            <button
              type="button"
              @click="deleteRecord"
              class="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-red-600 text-base font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 sm:ml-3 sm:w-auto sm:text-sm"
            >
              删除
            </button>
            <button
              type="button"
              @click="closeDeleteModal"
              class="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import {
  getRecords,
  createRecord,
  updateRecord,
  deleteRecord as apiDeleteRecord,
  getCategories,
  getPaymentMethods,
  getStatistics
} from '../api'

export default {
  name: 'RecordsView',
  setup() {
    // State
    const records = ref([])
    const categories = ref([])
    const paymentMethods = ref([])
    const statistics = ref({
      total_income: 0,
      total_expense: 0,
      balance: 0
    })
    const filters = reactive({
      month: '',
      category_id: '',
      type: ''
    })
    
    // Modal state
    const showRecordModal = ref(false)
    const showDeleteModal = ref(false)
    const editingRecord = ref(null)
    const deletingRecord = ref(null)
    const submitting = ref(false)
    const recordError = ref('')
    
    // Form state
    const recordForm = reactive({
      type: 'expense',
      amount: '',
      date: new Date().toISOString().split('T')[0],
      category_id: null,
      method_id: null,
      note: ''
    })

    // Computed
    const availableMonths = computed(() => {
      const months = new Set()
      records.value.forEach(record => {
        const month = record.date.substring(0, 7)
        months.add(month)
      })
      return Array.from(months).sort().reverse()
    })

    const filteredCategories = computed(() => {
      return categories.value.filter(cat => cat.type === recordForm.type)
    })

    // Methods
    const formatAmount = (amount) => {
      return Number(amount).toFixed(2)
    }

    const fetchRecords = async () => {
      try {
        const params = {}
        if (filters.month) params.month = filters.month
        if (filters.category_id) params.category_id = filters.category_id
        if (filters.type) params.type = filters.type
        
        const response = await getRecords(params)
        records.value = response.data
        
        // Fetch statistics with same filters
        const statsResponse = await getStatistics(params)
        statistics.value = statsResponse.data
      } catch (error) {
        console.error('获取记录失败:', error)
      }
    }

    const fetchCategories = async () => {
      try {
        const response = await getCategories()
        categories.value = response.data
      } catch (error) {
        console.error('获取分类失败:', error)
      }
    }

    const fetchPaymentMethods = async () => {
      try {
        const response = await getPaymentMethods()
        paymentMethods.value = response.data
      } catch (error) {
        console.error('获取支付方式失败:', error)
      }
    }

    const openRecordModal = (record = null) => {
      editingRecord.value = record
      recordError.value = ''
      
      if (record) {
        recordForm.type = record.type
        recordForm.amount = record.amount
        recordForm.date = record.date
        recordForm.category_id = record.category_id
        recordForm.method_id = record.method_id
        recordForm.note = record.note || ''
      } else {
        recordForm.type = 'expense'
        recordForm.amount = ''
        recordForm.date = new Date().toISOString().split('T')[0]
        recordForm.category_id = null
        recordForm.method_id = null
        recordForm.note = ''
      }
      
      showRecordModal.value = true
    }

    const closeRecordModal = () => {
      showRecordModal.value = false
      editingRecord.value = null
      recordError.value = ''
    }

    const submitRecord = async () => {
      submitting.value = true
      recordError.value = ''
      
      try {
        const data = {
          type: recordForm.type,
          amount: parseFloat(recordForm.amount),
          date: recordForm.date,
          category_id: recordForm.category_id,
          method_id: recordForm.method_id,
          note: recordForm.note
        }
        
        if (editingRecord.value) {
          await updateRecord(editingRecord.value.id, data)
        } else {
          await createRecord(data)
        }
        
        closeRecordModal()
        await fetchRecords()
      } catch (error) {
        recordError.value = error.response?.data?.error || '提交失败，请检查必填项'
      } finally {
        submitting.value = false
      }
    }

    const confirmDelete = (record) => {
      deletingRecord.value = record
      showDeleteModal.value = true
    }

    const closeDeleteModal = () => {
      showDeleteModal.value = false
      deletingRecord.value = null
    }

    const deleteRecord = async () => {
      if (!deletingRecord.value) return
      
      try {
        await apiDeleteRecord(deletingRecord.value.id)
        closeDeleteModal()
        await fetchRecords()
      } catch (error) {
        console.error('删除失败:', error)
        alert('删除失败: ' + (error.response?.data?.error || '未知错误'))
      }
    }

    // Lifecycle
    onMounted(async () => {
      await Promise.all([
        fetchRecords(),
        fetchCategories(),
        fetchPaymentMethods()
      ])
    })

    // Watch for type change to reset category
    watch(() => recordForm.type, () => {
      recordForm.category_id = null
    })

    return {
      records,
      categories,
      paymentMethods,
      statistics,
      filters,
      showRecordModal,
      showDeleteModal,
      editingRecord,
      deletingRecord,
      submitting,
      recordError,
      recordForm,
      availableMonths,
      filteredCategories,
      formatAmount,
      fetchRecords,
      openRecordModal,
      closeRecordModal,
      submitRecord,
      confirmDelete,
      closeDeleteModal,
      deleteRecord
    }
  }
}
</script>