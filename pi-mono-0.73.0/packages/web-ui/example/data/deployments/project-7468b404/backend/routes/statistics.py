from flask import Blueprint, request, jsonify
import sys
import os

# Add the backend directory to the path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models import db, Record
from sqlalchemy import func

statistics_bp = Blueprint('statistics', __name__)

@statistics_bp.route('/api/statistics', methods=['GET'])
def get_statistics():
    # Get filter parameters
    month = request.args.get('month')
    category_id = request.args.get('category_id')
    record_type = request.args.get('type')
    
    # Build base query
    query = db.session.query(
        func.sum(Record.amount).label('total_amount'),
        Record.type
    )
    
    if month:
        # Filter by month (YYYY-MM format)
        query = query.filter(Record.date.like(f'{month}%'))
    
    if category_id:
        query = query.filter(Record.category_id == category_id)
    
    if record_type:
        query = query.filter(Record.type == record_type)
    
    # Group by type and execute
    results = query.group_by(Record.type).all()
    
    # Calculate totals
    total_income = 0.0
    total_expense = 0.0
    
    for result in results:
        if result.type == 'income':
            total_income = result.total_amount or 0.0
        elif result.type == 'expense':
            total_expense = result.total_amount or 0.0
    
    # Calculate balance
    balance = total_income - total_expense
    
    return jsonify({
        'total_income': round(total_income, 2),
        'total_expense': round(total_expense, 2),
        'balance': round(balance, 2)
    })