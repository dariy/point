package services

import (
	"context"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type S3Presigner struct {
	client *s3.PresignClient
	bucket string
}

// NewS3Presigner initializes the S3 client pointed at any S3-compatible API.
// Returns nil if credentials are not provided (e.g., local storage mode).
func NewS3Presigner(endpoint, region, accessKey, secretKey, bucket string) (*S3Presigner, error) {
	if endpoint == "" || accessKey == "" || secretKey == "" || bucket == "" {
		return nil, nil // S3 direct-delivery not configured
	}

	if region == "" {
		region = "us-east-1" // Fallback, standard for AWS/S3-compat
	}

	cfg, err := config.LoadDefaultConfig(context.TODO(),
		config.WithRegion(region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
	)
	if err != nil {
		return nil, err
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
	})

	return &S3Presigner{
		client: s3.NewPresignClient(client),
		bucket: bucket,
	}, nil
}

// PresignGetObject returns a URL valid for 15 minutes to download the object directly.
func (p *S3Presigner) PresignGetObject(ctx context.Context, objectKey string) (string, error) {
	req, err := p.client.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(p.bucket),
		Key:    aws.String(objectKey),
	}, func(opts *s3.PresignOptions) {
		opts.Expires = 15 * time.Minute
	})
	if err != nil {
		return "", err
	}
	return req.URL, nil
}
