package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"point-api/internal/api"
	"point-api/internal/config"
	"point-api/internal/repository"
	"point-api/internal/services"
)

func main() {
	// Load configuration
	cfg, err := config.LoadConfig(".")
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	// Initialize repository
	repo, err := repository.NewRepository(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("failed to initialize repository: %v", err)
	}
	defer repo.Close()

	// Initialize Echo
	e := echo.New()

	// Services
	authService := services.NewAuthService(repo)

	// Handlers
	authHandler := api.NewAuthHandler(authService, &cfg)

	// Middleware
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.CORS())

	// Routes
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{
			"status":  "ok",
			"version": cfg.AppVersion,
		})
	})

	// Auth Routes
	authGroup := e.Group("/api/auth")
	authGroup.POST("/login", authHandler.Login)
	authGroup.POST("/logout", authHandler.Logout)
	authGroup.GET("/me", authHandler.Me, api.AuthMiddleware(authService))

	// Start server
	address := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	log.Printf("Starting server on %s", address)
	if err := e.Start(address); err != nil {
		log.Fatalf("failed to start server: %v", err)
	}
}
