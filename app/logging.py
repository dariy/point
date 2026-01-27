"""Logging configuration for the application.

Sets up logging to both console and file handlers.
"""

import logging
import sys
from pathlib import Path

from app.config import get_settings

def setup_logging():
    """Configure application logging."""
    settings = get_settings()
    
    # Determine log level
    log_level = logging.DEBUG if settings.debug else logging.INFO
    
    # Create log directory if it doesn't exist
    log_dir = Path(settings.storage_path) / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    
    log_file = log_dir / "app.log"
    error_log_file = log_dir / "error.log"
    
    # Create formatters
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    
    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    
    # File handler (all logs)
    file_handler = logging.FileHandler(log_file)
    file_handler.setFormatter(formatter)
    
    # Error file handler (only ERROR and above)
    error_file_handler = logging.FileHandler(error_log_file)
    error_file_handler.setLevel(logging.ERROR)
    error_file_handler.setFormatter(formatter)
    
    # Root logger configuration
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    
    # Remove existing handlers to avoid duplicates
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)
        
    root_logger.addHandler(console_handler)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(error_file_handler)
    
    # Set levels for some noisy loggers
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
    
    logging.info("Logging initialized. Writing to %s", log_file)
