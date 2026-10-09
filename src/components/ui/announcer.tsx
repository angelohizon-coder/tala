import React, { useEffect, useState } from "react"

export function Announcer({ message }: { message: string }) {
  const [announced, setAnnounced] = useState("")

  useEffect(() => {
    if (message) {
      setAnnounced(message)
      const timer = setTimeout(() => setAnnounced(""), 3000)
      return () => clearTimeout(timer)
    }
  }, [message])

  return (
    <div
      className="sr-only"
      aria-live="polite"
      aria-atomic="true"
    >
      {announced}
    </div>
  )
}

