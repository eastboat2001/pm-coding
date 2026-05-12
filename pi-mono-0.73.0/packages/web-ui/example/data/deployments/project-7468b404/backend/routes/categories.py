from flask import Blueprint, request, jsonify
import sys
import os

# Add the backend directory to the path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models import db, Category, Record

categories_bp = Blueprint('categories', __name__)

@categories_bp.route('/api/categories', methods=['GET'])
def get_categories():
    # Get filter parameter
    category_type = request.args.get('type')
    
    # Build query
    query = Category.query
    
    if category_type:
        query = query.filter(Category.type == category_type)
    
    # Sort by name
    categories = query.order_by(Category.name).all()
    
    return jsonify([category.to_dict() for category in categories])

@categories_bp.route('/api/categories', methods=['POST'])
def create_category():
    data = request.get_json()
    
    # Validate required fields
    if not data.get('name') or not data.get('type'):
        return jsonify({'error': '请完善必填信息'}), 400
    
    # Validate type
    if data['type'] not in ['income', 'expense']:
        return jsonify({'error': '无效的分类类型'}), 400
    
    # Check for duplicate name within same type
    existing = Category.query.filter_by(name=data['name'], type=data['type']).first()
    if existing:
        return jsonify({'error': '该分类已存在'}), 400
    
    # Create new category
    new_category = Category(
        name=data['name'],
        type=data['type']
    )
    
    db.session.add(new_category)
    db.session.commit()
    
    return jsonify(new_category.to_dict()), 201

@categories_bp.route('/api/categories/<int:category_id>', methods=['DELETE'])
def delete_category(category_id):
    category = Category.query.get_or_404(category_id)
    
    # Check if category is used in any records
    record_count = Record.query.filter_by(category_id=category_id).count()
    if record_count > 0:
        return jsonify({'error': '该分类已被使用，无法删除'}), 403
    
    db.session.delete(category)
    db.session.commit()
    
    return jsonify({'message': '分类已删除'}), 200