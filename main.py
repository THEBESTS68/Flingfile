from fastapi import FastAPI, UploadFile, File
from fastapi.responses import RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client, Client
import random
import string
import os

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ดึงค่า URL และ Key จาก Environment Variables ของ Vercel เพื่อความปลอดภัย
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")

# สร้างการเชื่อมต่อ Supabase
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def generate_code():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    code = generate_code()
    # ตั้งชื่อไฟล์ใหม่ด้วยรหัส เพื่อไม่ให้ชื่อซ้ำกันในระบบ
    file_path = f"{code}_{file.filename}" 
    
    # 1. อัปโหลดไฟล์ขึ้น Supabase Storage (Bucket ชื่อ 'uploads')
    file_bytes = await file.read()
    supabase.storage.from_("uploads").upload(file_path, file_bytes)
    
    # 2. บันทึกข้อมูลลง Database (Table ชื่อ 'files')
    supabase.table("files").insert({
        "code": code, 
        "file_name": file.filename,
        "file_path": file_path
    }).execute()
    
    return {"code": code}

@app.get("/api/download/{code}")
async def download_file(code: str):
    # 1. ค้นหารหัสใน Database
    response = supabase.table("files").select("*").eq("code", code).execute()
    
    if len(response.data) > 0:
        file_info = response.data[0]
        # 2. ดึง URL ของไฟล์จาก Storage แล้ว Redirect พาผู้ใช้ไปดาวน์โหลด
        file_url = supabase.storage.from_("uploads").get_public_url(file_info['file_path'])
        return RedirectResponse(url=file_url)
        
    return {"error": "ไม่พบรหัสนี้หรือไฟล์ถูกลบไปแล้ว"}