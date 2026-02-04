FROM point:base-dev

# Accept build version as argument
ARG BUILD_VERSION=dev
ENV APP_VERSION=${BUILD_VERSION}

# Copy application with ownership
COPY --chown=appuser:appuser app/ /app/app/
COPY --chown=appuser:appuser scripts/ /app/scripts/

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]