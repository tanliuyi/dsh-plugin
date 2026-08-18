import React from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './router'
import './globals.css'
import "./styles/markdown.css"

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
// 默认深色（跟随系统偏好）
const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? true
document.documentElement.classList.toggle('dark', prefersDark)

createRoot(el).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
