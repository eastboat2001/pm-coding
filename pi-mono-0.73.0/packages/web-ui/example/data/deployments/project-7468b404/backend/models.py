from flask_sqlalchemy import SQLAlchemy
from datetime import datetime

db = SQLAlchemy()

class Category(db.Model):
    __tablename__ = 'categories'
    
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name = db.Column(db.Text, nullable=False)
    type = db.Column(db.Text, db.CheckConstraint("type IN ('income', 'expense')"), nullable=False)
    
    # Relationships
    records = db.relationship('Record', backref='category', lazy=True)
    
    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'type': self.type
        }

class PaymentMethod(db.Model):
    __tablename__ = 'payment_methods'
    
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name = db.Column(db.Text, nullable=False)
    
    # Relationships
    records = db.relationship('Record', backref='payment_method', lazy=True)
    
    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name
        }

class Record(db.Model):
    __tablename__ = 'records'
    
    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    type = db.Column(db.Text, nullable=False)  # income / expense
    amount = db.Column(db.Float, nullable=False)
    date = db.Column(db.Text, nullable=False)  # YYYY-MM-DD
    category_id = db.Column(db.Integer, db.ForeignKey('categories.id'), nullable=True)
    method_id = db.Column(db.Integer, db.ForeignKey('payment_methods.id'), nullable=True)
    note = db.Column(db.Text, nullable=True)
    
    def to_dict(self):
        return {
            'id': self.id,
            'type': self.type,
            'amount': round(self.amount, 2),
            'date': self.date,
            'category_id': self.category_id,
            'category_name': self.category.name if self.category else None,
            'method_id': self.method_id,
            'method_name': self.payment_method.name if self.payment_method else None,
            'note': self.note
        }

# Seed data function
def seed_data(app):
    with app.app_context():
        db.create_all()
        
        # Check if data already exists
        if Category.query.first() is None:
            # Default categories
            default_categories = [
                # Income categories
                {'name': '工资', 'type': 'income'},
                {'name': '奖金', 'type': 'income'},
                {'name': '投资收益', 'type': 'income'},
                {'name': '其他收入', 'type': 'income'},
                # Expense categories
                {'name': '餐饮', 'type': 'expense'},
                {'name': '交通', 'type': 'expense'},
                {'name': '购物', 'type': 'expense'},
                {'name': '娱乐', 'type': 'expense'},
                {'name': '居住', 'type': 'expense'},
                {'name': '医疗', 'type': 'expense'},
                {'name': '教育', 'type': 'expense'},
                {'name': '其他支出', 'type': 'expense'},
            ]
            
            for cat_data in default_categories:
                category = Category(**cat_data)
                db.session.add(category)
            
            # Default payment methods
            default_methods = [
                {'name': '现金'},
                {'name': '微信'},
                {'name': '支付宝'},
                {'name': '银行卡'},
                {'name': '信用卡'},
            ]
            
            for method_data in default_methods:
                method = PaymentMethod(**method_data)
                db.session.add(method)
            
            db.session.commit()