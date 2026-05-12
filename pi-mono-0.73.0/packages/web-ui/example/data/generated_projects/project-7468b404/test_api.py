#!/usr/bin/env python3
"""
简单的 API 测试脚本
运行方式: python test_api.py
"""

import requests
import json

BASE_URL = 'http://localhost:5000/api'

def test_api():
    print("=== 个人记账系统 API 测试 ===\n")
    
    # Test 1: Get categories
    print("1. 测试获取分类列表...")
    try:
        response = requests.get(f'{BASE_URL}/categories')
        if response.status_code == 200:
            categories = response.json()
            print(f"   ✓ 成功获取 {len(categories)} 个分类")
            for cat in categories[:3]:
                print(f"     - {cat['name']} ({cat['type']})")
        else:
            print(f"   ✗ 失败: {response.status_code}")
    except Exception as e:
        print(f"   ✗ 连接失败: {e}")
        return False
    
    # Test 2: Get payment methods
    print("\n2. 测试获取支付方式列表...")
    try:
        response = requests.get(f'{BASE_URL}/payment-methods')
        if response.status_code == 200:
            methods = response.json()
            print(f"   ✓ 成功获取 {len(methods)} 个支付方式")
            for method in methods[:3]:
                print(f"     - {method['name']}")
        else:
            print(f"   ✗ 失败: {response.status_code}")
    except Exception as e:
        print(f"   ✗ 连接失败: {e}")
        return False
    
    # Test 3: Create a record
    print("\n3. 测试创建记录...")
    try:
        data = {
            'type': 'expense',
            'amount': 50.50,
            'date': '2024-01-15',
            'category_id': 5,  # 餐饮
            'method_id': 2,    # 微信
            'note': '午餐'
        }
        response = requests.post(f'{BASE_URL}/records', json=data)
        if response.status_code == 201:
            record = response.json()
            print(f"   ✓ 成功创建记录: ID={record['id']}, 金额={record['amount']}")
        else:
            print(f"   ✗ 失败: {response.status_code} - {response.text}")
    except Exception as e:
        print(f"   ✗ 连接失败: {e}")
        return False
    
    # Test 4: Get records
    print("\n4. 测试获取记录列表...")
    try:
        response = requests.get(f'{BASE_URL}/records')
        if response.status_code == 200:
            records = response.json()
            print(f"   ✓ 成功获取 {len(records)} 条记录")
        else:
            print(f"   ✗ 失败: {response.status_code}")
    except Exception as e:
        print(f"   ✗ 连接失败: {e}")
        return False
    
    # Test 5: Get statistics
    print("\n5. 测试获取统计信息...")
    try:
        response = requests.get(f'{BASE_URL}/statistics')
        if response.status_code == 200:
            stats = response.json()
            print(f"   ✓ 统计信息: 收入={stats['total_income']}, 支出={stats['total_expense']}, 结余={stats['balance']}")
        else:
            print(f"   ✗ 失败: {response.status_code}")
    except Exception as e:
        print(f"   ✗ 连接失败: {e}")
        return False
    
    # Test 6: Test delete protection
    print("\n6. 测试删除保护...")
    try:
        # Try to delete a category that is used
        response = requests.delete(f'{BASE_URL}/categories/5')
        if response.status_code == 403:
            print("   ✓ 删除保护正常工作: 已使用的分类无法删除")
        else:
            print(f"   ✗ 删除保护未生效: {response.status_code}")
    except Exception as e:
        print(f"   ✗ 连接失败: {e}")
        return False
    
    print("\n=== 测试完成 ===")
    return True

if __name__ == '__main__':
    test_api()