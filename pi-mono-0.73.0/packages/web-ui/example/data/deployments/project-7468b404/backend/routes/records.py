from flask import Blueprint, request, jsonify
import sys
import os

# Add the backend directory to the path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models import db, Record, Category, PaymentMethod
from sqlalchemy import extract, func
import datetime

records_bp = Blueprint('records', __name__)

@records_bp.route('/api/records', methods=['GET'])
def get_records():
    # Get filter parameters
    month = request.args.get('month')
    category_id = request.args.get('category_id')
    record_type = request.args.get('type')
    
    # Build query
    query = Record.query
    
    if month:
        # Filter by month (YYYY-MM format)
        query = query.filter(Record.date.like(f'{month}%'))
    
    if category_id:
        query = query.filter(Record.category_id == category_id)
    
    if record_type:
        query = query.filter(Record.type == record_type)
    
    # Sort by date descending
    records = query.order_by(Record.date.desc(), Record.id.desc()).all()
    
    return jsonify([record.to_dict() for record in records])

@records_bp.route('/api/records', methods=['POST'])
def create_record():
    data = request.get_json()
    
    # Validate required fields
    if not data.get('type') or not data.get('amount') or not data.get('date'):
        return jsonify({'error': '请完善必填信息'}), 400
    
    # Validate type
    if data['type'] not in ['income', 'expense']:
        return jsonify({'error': '无效的账目类型'}), 400
    
    # Validate amount
    try:
        amount = float(data['amount'])
        if amount <= 0:
            return jsonify({'error': '金额必须大于0'}), 400
    except (ValueError, TypeError):
        return jsonify({'error': '请输入有效的金额'}), 400
    
    # Validate date format
    try:
        datetime.datetime.strptime(data['date'], '%Y-%m-%d')
    except ValueError:
        return jsonify({'error': '日期格式无效，请使用 YYYY-MM-DD'}), 400
    
    # Validate category if provided
    if data.get('category_id'):
        category = Category.query.get(data['category_id'])
        if not category:
            return jsonify({'error': '指定的分类不存在'}), 400
        # Ensure category type matches record type
        if category.type != data['type']:
            return jsonify({'error': '分类类型与账目类型不匹配'}), 400
    
    # Validate payment method if provided
    if data.get('method_id'):
        method = PaymentMethod.query.get(data['method_id'])
        if not method:
            return jsonify({'error': '指定的支付方式不存在'}), 400
    
    # Create new record
    new_record = Record(
        type=data['type'],
        amount=round(amount, 2),
        date=data['date'],
        category_id=data.get('category_id'),
        method_id=data.get('method_id'),
        note=data.get('note', '')
    )
    
    db.session.add(new_record)
    db.session.commit()
    
    return jsonify(new_record.to_dict()), 201

@records_bp.route('/api/records/<int:record_id>', methods=['PUT'])
def update_record(record_id):
    record = Record.query.get_or_404(record_id)
    data = request.get_json()
    
    # Validate required fields
    if not data.get('type') or not data.get('amount') or not data.get('date'):
        return jsonify({'error': '请完善必填信息'}), 400
    
    # Validate type
    if data['type'] not in ['income', 'expense']:
        return jsonify({'error': '无效的账目类型'}), 400
    
    # Validate amount
    try:
        amount = float(data['amount'])
        if amount <= 0:
            return jsonify({'error': '金额必须大于0'}), 400
    except (ValueError, TypeError):
        return jsonify({'error': '请输入有效的金额'}), 400
    
    # Validate date format
    try:
        datetime.datetime.strptime(data['date'], '%Y-%m-%d')
    except ValueError:
        return jsonify({'error': '日期格式无效，请使用 YYYY-MM-DD'}), 400
    
    # Validate category if provided
    if data.get('category_id'):
        category = Category.query.get(data['category_id'])
        if not category:
            return jsonify({'error': '指定的分类不存在'}), 400
        # Ensure category type matches record type
        if category.type != data['type']:
            return jsonify({'error': '分类类型与账目类型不匹配'}), 400
    
    # Validate payment method if provided
    if data.get('method_id'):
        method = PaymentMethod.query.get(data['method_id'])
        if not method:
            return jsonify({'error': '指定的支付方式不存在'}), 400
    
    # Update record
    record.type = data['type']
    record.amount = round(amount, 2)
    record.date = data['date']
    record.category_id = data.get('category_id')
    record.method_id = data.get('method_id')
    record.note = data.get('note', '')
    
    db.session.commit()
    
    return jsonify(record.to_dict())

@records_bp.route('/api/records/<int:record_id>', methods=['DELETE'])
def delete_record(record_id):
    record = Record.query.get_or_404(record_id)
    
    db.session.delete(record)
    db.session.commit()
    
    return jsonify({'message': '记录已删除'}), 200