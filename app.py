from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd
import numpy as np
import joblib
import shap
from datetime import datetime
import os
from google import genai

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
MODEL_NAME = "gemini-2.5-flash"


def generate_llm_summary(risk_score, risk_level, reasons):

    prompt = f"""
You are a fraud detection analyst.

Risk Score: {risk_score}
Risk Level: {risk_level}

Key Risk Factors:
{", ".join(reasons)}

Explain clearly in 3-4 sentences:
1. Why this transaction is risky.
2. What behavioral pattern is observed.
3. What action bank should consider.

Be professional and concise.
"""

    try:
        response = client.models.generate_content(model=MODEL_NAME, contents=prompt)
        return (response.text or "").strip()
    except Exception as e:
        return "LLM explanation unavailable."
    
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,   # must be False with "*"
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------------
# Load Model + Feature List
# -------------------------------
model = joblib.load("fraud_model.pkl")
features = joblib.load("feature_list.pkl")
explainer = shap.TreeExplainer(model)

# -------------------------------
# In-Memory User History
# -------------------------------
user_history = {}

# -------------------------------
# Input Schema
# -------------------------------
class Transaction(BaseModel):
    transaction_id: str
    user_id: str
    amount: float
    timestamp: str
    device_id: str
    oldbalanceOrg: float
    newbalanceOrig: float
    oldbalanceDest: float
    newbalanceDest: float

# -------------------------------
# Risk Level Mapping
# -------------------------------
def get_risk_level(score):
    if score >= 80:
        return "High"
    elif score >= 40:
        return "Medium"
    else:
        return "Low"

# -------------------------------
# Feature Interpretation
# -------------------------------
def interpret_feature(feature_name):
    explanations = {
        "amount_deviation": "Transaction amount significantly deviates from user's historical average.",
        "device_changed": "Transaction initiated from a new or different device.",
        "time_diff_minutes": "Very short time gap between consecutive transactions.",
        "oldbalanceOrg": "Unusual sender balance pattern detected.",
        "newbalanceOrig": "Suspicious change in sender's account balance.",
        "newbalanceDest": "Unusual shift in destination account balance.",
        "night_flag": "Transaction occurred during unusual night hours."
    }
    return explanations.get(feature_name, f"{feature_name} influenced the risk score.")

# ---------------------------------------------------
# CORE LOGIC (Reusable — DO NOT CALL ROUTE DIRECTLY)
# ---------------------------------------------------
def process_transaction(transaction: dict):

    user_id = transaction["user_id"]
    amount = transaction["amount"]
    timestamp = datetime.fromisoformat(transaction["timestamp"])
    device_id = transaction["device_id"]

    if user_id not in user_history:
        user_history[user_id] = []

    history = user_history[user_id]

    # Behavioral Features
    if len(history) == 0:
        user_avg_amount = amount
        time_diff_minutes = 0
        device_changed = 0
    else:
        previous = history[-1]
        user_avg_amount = np.mean([h["amount"] for h in history])
        time_diff_minutes = (timestamp - previous["timestamp"]).total_seconds() / 60
        device_changed = int(device_id != previous["device_id"])

    amount_deviation = amount / user_avg_amount if user_avg_amount != 0 else 1
    night_flag = int(timestamp.hour <= 5)

    # Model Input
    input_data = pd.DataFrame([{
        "amount": amount,
        "oldbalanceOrg": transaction["oldbalanceOrg"],
        "newbalanceOrig": transaction["newbalanceOrig"],
        "oldbalanceDest": transaction["oldbalanceDest"],
        "newbalanceDest": transaction["newbalanceDest"],
        "user_avg_amount": user_avg_amount,
        "amount_deviation": amount_deviation,
        "time_diff_minutes": time_diff_minutes,
        "device_changed": device_changed,
        "night_flag": night_flag
    }])

    input_data = input_data[features]

    # Prediction
    prob = model.predict_proba(input_data)[0][1]
    risk_score = float(round(prob * 100, 2))
    risk_level = get_risk_level(risk_score)

    # SHAP Explainability
    shap_values = explainer.shap_values(input_data)
    shap_contrib = pd.Series(shap_values[0], index=features)

    positive_contrib = shap_contrib[shap_contrib > 0]
    top_features = positive_contrib.sort_values(ascending=False).head(3)

    reasons = [interpret_feature(f) for f in top_features.index]

   
    llm_summary = generate_llm_summary(risk_score, risk_level, reasons)

    # Store History
    user_history[user_id].append({
        "amount": amount,
        "timestamp": timestamp,
        "device_id": device_id,
        "risk_score": risk_score
    })

    return {
        "transaction_id": transaction["transaction_id"],
        "risk_score": risk_score,
        "risk_level": risk_level,
        "reasons": reasons,
        "llm_summary": llm_summary
    }

# -------------------------------
# SINGLE TRANSACTION ENDPOINT
# -------------------------------
@app.post("/predict")
def predict(transaction: Transaction):
    return process_transaction(transaction.dict())

# -------------------------------
# RISK HISTORY ENDPOINT
# -------------------------------
@app.get("/risk_history/{user_id}")
def get_risk_history(user_id: str):

    if user_id not in user_history:
        return {"risk_history": []}

    return {
        "risk_history": [
            {
                "timestamp": str(h["timestamp"]),
                "risk_score": h["risk_score"]
            }
            for h in user_history[user_id]
        ]
    }

# -------------------------------
# CSV UPLOAD ENDPOINT
# -------------------------------
@app.post("/upload_csv")
async def upload_csv(file: UploadFile = File(...)):

    df = pd.read_csv(file.file)

    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.sort_values(["user_id", "timestamp"])

    results = []

    for _, row in df.iterrows():

        transaction = {
            "transaction_id": row["transaction_id"],
            "user_id": row["user_id"],
            "amount": float(row["amount"]),
            "timestamp": row["timestamp"].isoformat(),
            "device_id": row["device_id"],
            "oldbalanceOrg": float(row["oldbalanceOrg"]),
            "newbalanceOrig": float(row["newbalanceOrig"]),
            "oldbalanceDest": float(row["oldbalanceDest"]),
            "newbalanceDest": float(row["newbalanceDest"])
        }

        result = process_transaction(transaction)

        results.append({
            "transaction_id": result["transaction_id"],
            "risk_score": result["risk_score"],
            "risk_level": result["risk_level"]
        })

    return {"results": results}

# -------------------------------
# RESET USER HISTORY (For Demo)
# -------------------------------
@app.post("/reset")
def reset_history():
    global user_history
    user_history = {}
    return {"status": "User history cleared successfully"}

@app.get("/health")
def health():
    return {"ok": True}