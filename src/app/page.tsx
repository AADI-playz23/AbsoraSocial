"use client";

import React, { useState } from "react";
import UploadButton from "../components/UploadButton";
import { Heart, MessageCircle, Send } from "lucide-react";

// Temporary sample data until we connect the Neon API
const initialPosts = [
  {
    id: 1,
    username: "coder_aadi",
    imageUrl: "https://res.cloudinary.com/demo/image/upload/v1312461204/sample.jpg",
    caption: "Just built my custom Cloudinary upload engine! 🚀",
    likes: 42,
  }
];

export default function Home() {
  const [posts, setPosts] = useState(initialPosts);
  const [caption, setCaption] = useState("");
  const [uploadedImageUrl, setUploadedImageUrl] = useState("");

  const handleUploadSuccess = (url: string) => {
    setUploadedImageUrl(url);
  };

  const handleCreatePost = (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadedImageUrl) return;

    // Create a new post object locally
    const newPost = {
      id: posts.length + 1,
      username: "You",
      imageUrl: uploadedImageUrl,
      caption: caption,
      likes: 0,
    };

    // Add it to the top of the feed
    setPosts([newPost, ...posts]);
    
    // Clear the form
    setCaption("");
    setUploadedImageUrl("");
  };

  return (
    <main className="min-h-screen bg-gray-50 pb-12">
      {/* Navigation Bar */}
      <nav className="sticky top-0 bg-white border-b border-gray-200 h-16 flex items-center justify-between px-4 max-w-lg mx-auto z-50">
        <h1 className="text-xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-purple-600 to-blue-500">
          AbsoraSocial
        </h1>
      </nav>

      <div className="max-w-lg mx-auto px-4 mt-6 space-y-6">
        
        {/* Create Post Form */}
        <div className="bg-white p-4 rounded-2xl border border-gray-200 shadow-sm space-y-4">
          <h2 className="font-semibold text-gray-800">Create a New Post</h2>
          
          {uploadedImageUrl ? (
            <div className="relative rounded-xl overflow-hidden bg-gray-100 border h-48">
              <img src={uploadedImageUrl} alt="Preview" className="w-full h-full object-cover" />
              <button 
                onClick={() => setUploadedImageUrl("")}
                className="absolute top-2 right-2 bg-black/70 text-white text-xs px-3 py-1.5 rounded-full hover:bg-black transition"
              >
                Remove
              </button>
            </div>
          ) : (
            <UploadButton onUploadSuccess={handleUploadSuccess} />
          )}

          <form onSubmit={handleCreatePost} className="space-y-3">
            <input
              type="text"
              placeholder="Write a caption..."
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              className="w-full px-4 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50"
            />
            <button
              type="submit"
              disabled={!uploadedImageUrl}
              className="w-full bg-gradient-to-r from-blue-600 to-purple-600 text-white py-2.5 rounded-xl font-medium text-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <Send className="w-4 h-4" /> Share Post
            </button>
          </form>
        </div>

        {/* The Feed */}
        <div className="space-y-6">
          {posts.map((post) => (
            <article key={post.id} className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
              
              {/* Post Header */}
              <div className="flex items-center px-4 py-3 border-b border-gray-100">
                <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-purple-500 to-blue-500 flex items-center justify-center text-white font-bold text-xs uppercase">
                  {post.username[0]}
                </div>
                <span className="ml-3 font-semibold text-sm text-gray-800">{post.username}</span>
              </div>

              {/* Post Image */}
              <div className="aspect-square bg-gray-50 flex items-center justify-center overflow-hidden">
                <img src={post.imageUrl} alt="Post content" className="w-full h-full object-cover" />
              </div>

              {/* Action Buttons */}
              <div className="px-4 pt-3 pb-4 space-y-2">
                <div className="flex items-center gap-4 text-gray-700">
                  <button className="hover:text-red-500 transition">
                    <Heart className="w-6 h-6" />
                  </button>
                  <button className="hover:text-blue-500 transition">
                    <MessageCircle className="w-6 h-6" />
                  </button>
                </div>

                {/* Likes & Caption */}
                <p className="text-sm font-bold text-gray-800">{post.likes} likes</p>
                <p className="text-sm text-gray-700">
                  <span className="font-bold mr-2 text-gray-900">{post.username}</span>
                  {post.caption}
                </p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
