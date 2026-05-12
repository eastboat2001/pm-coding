from flask import Blueprint, request, jsonify
import sys
import os

# Add the backend directory to the path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models import db, PaymentMethod, Record

payment_methods_bp = Blueprint('payment_methods', __name__)

@payment_methods_bp.route('/api/payment-methods', methods=['GET'])
def get_payment_methods():
    # Get all payment methods sorted by name
    methods = PaymentMethod.query.order_by(PaymentMethod.name).all()
    
    return jsonify([method.to_dict() for method in methods])

@payment_methods_bp.route('/api/payment-methods', methods=['POST'])
def create_payment_method():
    data = request.get_json()
    
    # Validate required fields
    if not data.get('name'):
        return jsonify({'error': '请完善必填信息'}), 400
    
    # Check for duplicate name
    existing = PaymentMethod.query.filter_by(name=data['name']).first()
    if existing:
        return jsonify({'error': '该支付方式已存在'}), 400
    
    # Create new payment method
    new_method = PaymentMethod(
        name=data['name']
    )
    
    db.session.add(new_method)
    db.session.commit()
    
    return jsonify(new_method.to_dict()), 201

@payment_methods_bp.route('/api/payment-methods/<int:method_id>', methods=['DELETE'])
def delete_payment_method(method_id):
    method = PaymentMethod.query.get_or_404(method_id)
    
    # Check if method is used in any records
    record_count = Record.query.filter_by(method_id=method_id).count()
    if record_count > 0:
        return jsonify({'error': '该支付方式已被使用，无法删除'}), 403
    
    db.session.delete(method)
    db.session.commit()
    
    return jsonify({'message': '支付方式已删除'}), 200