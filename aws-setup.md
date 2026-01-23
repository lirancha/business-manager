# AWS Setup Guide for Business Manager

This guide walks you through setting up the AWS infrastructure for the Business Manager app.

## Quick Start (Recommended)

The easiest way to set up DynamoDB tables and import data:

```bash
# 1. Create .env file with your AWS credentials
cat > .env << 'EOF'
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=eu-central-1
EOF

# 2. Install dependencies
npm install

# 3. Run the import script (creates tables + imports data)
node import-dynamodb.js
```

## Prerequisites

- AWS CLI installed and configured
- Node.js 18+ installed
- AWS account with permissions for Lambda, API Gateway, and DynamoDB

## Step 1: Create DynamoDB Tables

**Option A: Using the import script (recommended)**
```bash
node import-dynamodb.js
```

**Option B: Using AWS CLI**

```bash
# Create locations table
aws dynamodb create-table \
    --table-name business-manager-locations \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region eu-central-1

# Create schedules table
aws dynamodb create-table \
    --table-name business-manager-schedules \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region eu-central-1

# Create reminders table
aws dynamodb create-table \
    --table-name business-manager-reminders \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region eu-central-1

# Create backups table
aws dynamodb create-table \
    --table-name business-manager-backups \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region eu-central-1
```

## Step 2: Create IAM Role for Lambda

```bash
# Create the trust policy file
cat > trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create the IAM role
aws iam create-role \
    --role-name business-manager-lambda-role \
    --assume-role-policy-document file://trust-policy.json

# Attach basic Lambda execution policy
aws iam attach-role-policy \
    --role-name business-manager-lambda-role \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Create DynamoDB policy
cat > dynamodb-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": [
        "arn:aws:dynamodb:eu-central-1:*:table/business-manager-*"
      ]
    }
  ]
}
EOF

# Create and attach DynamoDB policy
aws iam put-role-policy \
    --role-name business-manager-lambda-role \
    --policy-name DynamoDBAccess \
    --policy-document file://dynamodb-policy.json
```

## Step 3: Deploy Lambda Function

```bash
# Navigate to lambda directory
cd lambda

# Install dependencies
npm install

# Create deployment package
zip -r function.zip index.js node_modules package.json

# Create Lambda function
aws lambda create-function \
    --function-name business-manager-api \
    --runtime nodejs18.x \
    --handler index.handler \
    --role arn:aws:iam::YOUR_ACCOUNT_ID:role/business-manager-lambda-role \
    --zip-file fileb://function.zip \
    --environment Variables="{ALLOWED_ORIGIN=https://lirancha.github.io}" \
    --region eu-central-1 \
    --timeout 30 \
    --memory-size 256

# (Replace YOUR_ACCOUNT_ID with your AWS account ID)
```

To update the function later:
```bash
cd lambda && npm install && zip -r function.zip index.js node_modules package.json
aws lambda update-function-code \
    --function-name business-manager-api \
    --zip-file fileb://function.zip \
    --region eu-central-1
```

## Step 4: Create API Gateway

### Option A: Using AWS Console (Recommended for first time)

1. Go to API Gateway in AWS Console
2. Create new REST API (not HTTP API)
3. Create resources and methods:

```
/locations/{locationId}     GET, PUT, OPTIONS
/schedules/config           GET, PUT, OPTIONS
/schedules/{weekId}         GET, PUT, OPTIONS
/reminders                  GET, POST, OPTIONS
/reminders/{id}             GET, PUT, DELETE, OPTIONS
/backups                    GET, POST, OPTIONS
```

4. For each method:
   - Integration type: Lambda Function
   - Lambda Function: business-manager-api
   - Use Lambda Proxy integration: YES

5. Enable CORS for each resource
6. Deploy API to a stage called "prod"

### Option B: Using AWS CLI

```bash
# Create REST API
API_ID=$(aws apigateway create-rest-api \
    --name "business-manager-api" \
    --region eu-central-1 \
    --query 'id' --output text)

echo "API ID: $API_ID"

# Get root resource ID
ROOT_ID=$(aws apigateway get-resources \
    --rest-api-id $API_ID \
    --region eu-central-1 \
    --query 'items[?path==`/`].id' --output text)

# Create /locations resource
LOCATIONS_ID=$(aws apigateway create-resource \
    --rest-api-id $API_ID \
    --parent-id $ROOT_ID \
    --path-part "locations" \
    --region eu-central-1 \
    --query 'id' --output text)

# Create /locations/{locationId} resource
LOCATION_ID=$(aws apigateway create-resource \
    --rest-api-id $API_ID \
    --parent-id $LOCATIONS_ID \
    --path-part "{locationId}" \
    --region eu-central-1 \
    --query 'id' --output text)

# Add GET method to /locations/{locationId}
aws apigateway put-method \
    --rest-api-id $API_ID \
    --resource-id $LOCATION_ID \
    --http-method GET \
    --authorization-type NONE \
    --region eu-central-1

# Add Lambda integration (repeat for each method)
aws apigateway put-integration \
    --rest-api-id $API_ID \
    --resource-id $LOCATION_ID \
    --http-method GET \
    --type AWS_PROXY \
    --integration-http-method POST \
    --uri "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-central-1:YOUR_ACCOUNT_ID:function:business-manager-api/invocations" \
    --region eu-central-1

# Continue for other resources and methods...
# (This gets repetitive - Console is easier)
```

## Step 5: Add API Gateway Permission to Lambda

```bash
aws lambda add-permission \
    --function-name business-manager-api \
    --statement-id apigateway-invoke \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:eu-central-1:YOUR_ACCOUNT_ID:$API_ID/*/*/*" \
    --region eu-central-1
```

## Step 6: Create API Key and Usage Plan (Optional but recommended)

```bash
# Create API key
aws apigateway create-api-key \
    --name "business-manager-key" \
    --enabled \
    --region eu-central-1

# Create usage plan
aws apigateway create-usage-plan \
    --name "business-manager-plan" \
    --throttle burstLimit=100,rateLimit=50 \
    --quota limit=10000,period=DAY \
    --region eu-central-1

# Associate API key with usage plan
# (Use the IDs from the above commands)
```

## Step 7: Update Frontend

After deploying, you'll get an API Gateway URL like:
```
https://abc123xyz.execute-api.eu-central-1.amazonaws.com/prod
```

Update the `api-client.js` file:
```javascript
this.baseUrl = config.baseUrl || 'https://abc123xyz.execute-api.eu-central-1.amazonaws.com/prod';
```

## Step 8: Migrate Data from Firebase

Use the existing migration scripts in the `migration/` folder:
1. Run `migration/export-firebase.js` to export data from Firebase
2. Run `migration/import-dynamodb.js` to import data into DynamoDB

## Verification Checklist

- [ ] DynamoDB tables created (4 tables)
- [ ] IAM role created with DynamoDB permissions
- [ ] Lambda function deployed
- [ ] API Gateway configured with all routes
- [ ] CORS enabled on all endpoints
- [ ] Lambda permission added for API Gateway
- [ ] Frontend updated with API Gateway URL
- [ ] Data migrated from Firebase
- [ ] Test all CRUD operations
- [ ] Test real-time sync (polling)
- [ ] Remove Firebase SDK from HTML files

## Troubleshooting

### CORS Errors
- Ensure OPTIONS method is configured for each resource
- Check Lambda returns proper CORS headers
- Verify ALLOWED_ORIGIN environment variable matches your domain

### 403 Forbidden
- Check Lambda permission for API Gateway
- Verify API key if using one

### 500 Internal Server Error
- Check CloudWatch logs for Lambda errors
- Verify DynamoDB table names match
- Check IAM role permissions

### No Data Showing
- Verify data was migrated to DynamoDB
- Check browser console for API errors
- Ensure baseUrl in api-client.js is correct
