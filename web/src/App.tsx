import { Route, Routes } from "react-router-dom";
import Header from "@/components/Header";
import Board from "@/pages/Board";
import TaskDetail from "@/pages/TaskDetail";
import Settings from "@/pages/Settings";

export default function App() {
  return (
    <div className="min-h-full flex flex-col bg-bg text-fg">
      <Header />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/tasks/:id" element={<TaskDetail />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
