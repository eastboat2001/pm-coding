<template>
  <div class="min-h-screen bg-gray-100">
    <!-- Navigation -->
    <nav class="bg-white shadow">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16">
          <div class="flex">
            <div class="flex-shrink-0 flex items-center">
              <h1 class="text-xl font-bold text-gray-800">个人记账系统</h1>
            </div>
            <div class="hidden sm:ml-6 sm:flex sm:space-x-8">
              <button
                @click="currentView = 'records'"
                :class="[
                  'inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium',
                  currentView === 'records'
                    ? 'border-indigo-500 text-gray-900'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                ]"
              >
                收支记录
              </button>
              <button
                @click="currentView = 'config'"
                :class="[
                  'inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium',
                  currentView === 'config'
                    ? 'border-indigo-500 text-gray-900'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                ]"
              >
                设置
              </button>
            </div>
          </div>
        </div>
      </div>
    </nav>

    <!-- Main Content -->
    <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      <RecordsView v-if="currentView === 'records'" />
      <ConfigView v-else-if="currentView === 'config'" />
    </main>
  </div>
</template>

<script>
import { ref } from 'vue'
import RecordsView from './views/RecordsView.vue'
import ConfigView from './views/ConfigView.vue'

export default {
  name: 'App',
  components: {
    RecordsView,
    ConfigView
  },
  setup() {
    const currentView = ref('records')
    
    return {
      currentView
    }
  }
}
</script>