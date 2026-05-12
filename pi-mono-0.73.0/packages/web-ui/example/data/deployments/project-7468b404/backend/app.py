import os
import sys
from flask import Flask, send_from_directory
from flask_cors import CORS

# Add the backend directory to the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from models import db, seed_data
from routes.records import records_bp
from routes.categories import categories_bp
from routes.payment_methods import payment_methods_bp
from routes.statistics import statistics_bp

def create_app():
    app = Flask(__name__, instance_relative_config=True)
    
    # Configure the SQLite database
    app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get(
        'DATABASE_URL', 
        'sqlite:///' + os.path.join(app.instance_path, 'ledger.db')
    )
    app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    
    # Ensure the instance folder exists
    try:
        os.makedirs(app.instance_path)
    except OSError:
        pass
    
    # Initialize extensions
    db.init_app(app)
    CORS(app)
    
    # Register blueprints
    app.register_blueprint(records_bp)
    app.register_blueprint(categories_bp)
    app.register_blueprint(payment_methods_bp)
    app.register_blueprint(statistics_bp)
    
    # Seed initial data
    seed_data(app)
    
    # Serve static files (for production)
    @app.route('/', defaults={'path': ''})
    @app.route('/<path:path>')
    def serve(path):
        if path and os.path.exists(os.path.join('static', path)):
            return send_from_directory('static', path)
        return send_from_directory('static', 'index.html')
    
    return app

if __name__ == '__main__':
    app = create_app()
    app.run(debug=True, host='0.0.0.0', port=5000)