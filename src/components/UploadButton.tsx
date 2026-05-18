"use client";

import React, { useState } from "react";
import { Camera, Loader2 } from "lucide-react";

interface UploadButtonProps {
  onUploadSuccess: (url: string) => void;
}

export default function UploadButton({ onUploadSuccess }: UploadButtonProps) {
  const [isUploading, setIsUploading] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);

    // Prepare the data for Cloudinary
    const formData = new FormData();
    formData.append("file", file);
    // Next.js automatically injects your preset from Vercel!
    formData.append("upload_preset", process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET!);

    try {
      // Send directly to Cloudinary (bypassing Vercel bandwidth)
      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME}/image/upload`,
        {
          method: "POST",
          body: formData,
        }
      );

      if (!response.ok) throw new Error("Upload failed");

      const data = await response.json();
      
      // Success! Pass the permanent URL back up to the main page
      onUploadSuccess(data.secure_url);
    } catch (error) {
      console.error("Error uploading image:", error);
      alert("Upload failed. Make sure your keys are in Vercel!");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <label className="flex flex-col items-center justify-center w-full h-40 border-2 border-dashed border-gray-300 rounded-xl cursor-pointer hover:bg-gray-50 transition bg-white relative overflow-hidden group">
      {isUploading ? (
        <div className="flex flex-col items-center gap-2 text-blue-500 z-10">
          <Loader2 className="w-8 h-8 animate-spin" />
          <span className="text-sm font-medium">Uploading to Cloudinary...</span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 text-gray-500 z-10 group-hover:text-blue-500 transition-colors">
          <Camera className="w-8 h-8" />
          <span className="text-sm font-medium">Select a Photo</span>
        </div>
      )}
      <input
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
        disabled={isUploading}
      />
    </label>
  );
}
