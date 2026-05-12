<template>
  <div class="space-y-6">
    <!-- Categories Section -->
    <div class="bg-white shadow rounded-lg p-6">
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-lg font-medium text-gray-900">分类管理</h2>
        <button
          @click="openCategoryModal()"
          class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          添加分类
        </button>
      </div>

      <!-- Income Categories -->
      <div class="mb-6">
        <h3 class="text-md font-medium text-gray-700 mb-3">收入类</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <div
            v-for="category in incomeCategories"
            :key="category.id"
            class="flex items-center justify-between p-3 bg-green-50 rounded-lg"
          >
            <span class="text-sm text-green-800">{{ category.name }}</span>
            <button
              @click="confirmDeleteCategory(category)"
              class="text-red-600 hover:text-red-800 text-sm"
            >
              删除
            </button>
          </div>
          <div v-if="incomeCategories.length === 0" class="col-span-full text-center text-gray-500 py-4">
            暂无收入分类
          </div>
        </div>
      </div>

      <!-- Expense Categories -->
      <div>
        <h3 class="text-md font-medium text-gray-700 mb-3">支出类</h3>
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <div
            v-for="category in expenseCategories"
            :key="category.id"
            class="flex items-center justify-between p-3 bg-red-50 rounded-lg"
          >
            <span class="text-sm text-red-800">{{ category.name }}</span>
            <button
              @click="confirmDeleteCategory(category)"
              class="text-red-600 hover:text-red-800 text-sm"
            >
              删除
            </button>
          </div>
          <div v-if="expenseCategories.length === 0" class="col-span-full text-center text-gray-500 py-4">
            暂无支出分类
          </div>
        </div>
      </div>
    </div>

    <!-- Payment Methods Section -->
    <div class="bg-white shadow rounded-lg p-6">
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-lg font-medium text-gray-900">支付方式管理</h2>
        <button
          @click="openPaymentMethodModal()"
          class="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          添加支付方式
        </button>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <div
          v-for="method in paymentMethods"
          :key="method.id"
          class="flex items-center justify-between p-3 bg-blue-50 rounded-lg"
        >
          <span class="text-sm text-blue-800">{{ method.name }}</span>
          <button
            @click="confirmDeletePaymentMethod(method)"
            class="text-red-600 hover:text-red-800 text-sm"
          >
            删除
          </button>
        </div>
        <div v-if="paymentMethods.length === 0" class="col-span-full text-center text-gray-500 py-4">
          暂无支付方式
        </div>
      </div>
    </div>

    <!-- Category Modal -->
    <div v-if="showCategoryModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        <div class="fixed inset-0 transition-opacity" @click="closeCategoryModal">
          <div class="absolute inset-0 bg-gray-500 opacity-75"></div>
        </div>

        <span class="hidden sm:inline-block sm:align-middle sm:h-screen">&#8203;</span>

        <div
          class="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full"
        >
          <div class="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
            <h3 class="text-lg leading-6 font-medium text-gray-900 mb-4">添加分类</h3>
            <form @submit.prevent="submitCategory">
              <div class="space-y-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">
                    分类名称 <span class="text-red-500">*</span>
                  </label>
                  <input
                    v-model="categoryForm.name"
                    type="text"
                    required
                    class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                    placeholder="请输入分类名称"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">
                    分类类型 <span class="text-red-500">*</span>
                  </label>
                  <select
                    v-model="categoryForm.type"
                    required
                    class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  >
                    <option value="income">收入类</option>
                    <option value="expense">支出类</option>
                  </select>
                </div>
              </div>

              <div v-if="categoryError" class="mt-4 text-sm text-red-600">
                {{ categoryError }}
              </div>

              <div class="mt-6 flex justify-end space-x-3">
                <button
                  type="button"
                  @click="closeCategoryModal"
                  class="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  取消
                </button>
                <button
                  type="submit"
                  :disabled="submittingCategory"
                  class="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                  {{ submittingCategory ? '提交中...' : '提交' }}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>

    <!-- Payment Method Modal -->
    <div v-if="showPaymentMethodModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-end justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        <div class="fixed inset-0 transition-opacity" @click="closePaymentMethodModal">
          <div class="absolute inset-0 bg-gray-500 opacity-75"></div>
        </div>

        <span class="hidden sm:inline-block sm:align-middle sm:h-screen">&#8203;</span>

        <div
          class="inline-block align-bottom bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full"
        >
          <div class="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
            <h3 class="text-lg leading-6 font-medium text-gray-900 mb-4">添加支付方式</h3>
            <form @submit.prevent="submitPaymentMethod">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">
                  支付方式名称 <span class="text-red-500">*</span>
                </label>
                <input
                  v-model="paymentMethodForm.name"
                  type="text"
                  required
                  class="block w-full border-gray-300 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                  placeholder="请输入支付方式名称"
                />
              </div>

              <div v-if="paymentMethodError" class="mt-4 text-sm text-red-600">
                {{ paymentMethodError }}
              </div>

              <div class="mt-6 flex justify-end space-x-3">
                <button
                  type="button"
                  @click="closePaymentMethodModal"
                  class="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  取消
                </button>
                <button
                  type="submit"
                  :disabled="submittingPaymentMethod"
                  class="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                  {{ submittingPaymentMethod ? '提交中...' : '提交' }}
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
                  <p class="text-sm text-gray-500">
                    {{ deleteConfirmMessage }}
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div class="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
            <button
              type="button"
              @click="executeDelete"
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
import { ref, reactive, computed, onMounted } from 'vue'
import {
  getCategories,
  createCategory,
  deleteCategory as apiDeleteCategory,
  getPaymentMethods,
  createPaymentMethod,
  deletePaymentMethod as apiDeletePaymentMethod
} from '../api'

export default {
  name: 'ConfigView',
  setup() {
    // State
    const categories = ref([])
    const paymentMethods = ref([])
    
    // Category modal state
    const showCategoryModal = ref(false)
    const submittingCategory = ref(false)
    const categoryError = ref('')
    const categoryForm = reactive({
      name: '',
      type: 'expense'
    })
    
    // Payment method modal state
    const showPaymentMethodModal = ref(false)
    const submittingPaymentMethod = ref(false)
    const paymentMethodError = ref('')
    const paymentMethodForm = reactive({
      name: ''
    })
    
    // Delete modal state
    const showDeleteModal = ref(false)
    const deleteType = ref('') // 'category' or 'paymentMethod'
    const deleteItem = ref(null)
    const deleteConfirmMessage = ref('')

    // Computed
    const incomeCategories = computed(() => {
      return categories.value.filter(cat => cat.type === 'income')
    })

    const expenseCategories = computed(() => {
      return categories.value.filter(cat => cat.type === 'expense')
    })

    // Methods
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

    // Category methods
    const openCategoryModal = () => {
      categoryForm.name = ''
      categoryForm.type = 'expense'
      categoryError.value = ''
      showCategoryModal.value = true
    }

    const closeCategoryModal = () => {
      showCategoryModal.value = false
      categoryError.value = ''
    }

    const submitCategory = async () => {
      submittingCategory.value = true
      categoryError.value = ''
      
      try {
        await createCategory({
          name: categoryForm.name,
          type: categoryForm.type
        })
        
        closeCategoryModal()
        await fetchCategories()
      } catch (error) {
        categoryError.value = error.response?.data?.error || '提交失败'
      } finally {
        submittingCategory.value = false
      }
    }

    // Payment method methods
    const openPaymentMethodModal = () => {
      paymentMethodForm.name = ''
      paymentMethodError.value = ''
      showPaymentMethodModal.value = true
    }

    const closePaymentMethodModal = () => {
      showPaymentMethodModal.value = false
      paymentMethodError.value = ''
    }

    const submitPaymentMethod = async () => {
      submittingPaymentMethod.value = true
      paymentMethodError.value = ''
      
      try {
        await createPaymentMethod({
          name: paymentMethodForm.name
        })
        
        closePaymentMethodModal()
        await fetchPaymentMethods()
      } catch (error) {
        paymentMethodError.value = error.response?.data?.error || '提交失败'
      } finally {
        submittingPaymentMethod.value = false
      }
    }

    // Delete methods
    const confirmDeleteCategory = (category) => {
      deleteType.value = 'category'
      deleteItem.value = category
      deleteConfirmMessage.value = `确认删除分类"${category.name}"吗？如果该分类已被账目使用，将无法删除。`
      showDeleteModal.value = true
    }

    const confirmDeletePaymentMethod = (method) => {
      deleteType.value = 'paymentMethod'
      deleteItem.value = method
      deleteConfirmMessage.value = `确认删除支付方式"${method.name}"吗？如果该支付方式已被账目使用，将无法删除。`
      showDeleteModal.value = true
    }

    const closeDeleteModal = () => {
      showDeleteModal.value = false
      deleteType.value = ''
      deleteItem.value = null
      deleteConfirmMessage.value = ''
    }

    const executeDelete = async () => {
      if (!deleteItem.value) return
      
      try {
        if (deleteType.value === 'category') {
          await apiDeleteCategory(deleteItem.value.id)
          await fetchCategories()
        } else if (deleteType.value === 'paymentMethod') {
          await apiDeletePaymentMethod(deleteItem.value.id)
          await fetchPaymentMethods()
        }
        
        closeDeleteModal()
      } catch (error) {
        alert(error.response?.data?.error || '删除失败')
        closeDeleteModal()
      }
    }

    // Lifecycle
    onMounted(async () => {
      await Promise.all([
        fetchCategories(),
        fetchPaymentMethods()
      ])
    })

    return {
      categories,
      paymentMethods,
      incomeCategories,
      expenseCategories,
      showCategoryModal,
      submittingCategory,
      categoryError,
      categoryForm,
      showPaymentMethodModal,
      submittingPaymentMethod,
      paymentMethodError,
      paymentMethodForm,
      showDeleteModal,
      deleteConfirmMessage,
      openCategoryModal,
      closeCategoryModal,
      submitCategory,
      openPaymentMethodModal,
      closePaymentMethodModal,
      submitPaymentMethod,
      confirmDeleteCategory,
      confirmDeletePaymentMethod,
      closeDeleteModal,
      executeDelete
    }
  }
}
</script>