import { Navigate, Route, Routes } from "react-router-dom";

import { Shell } from "@/components/Shell";
import ApiPage from "@/pages/ApiPage";
import GeneratePage from "@/pages/GeneratePage";
import HistoryPage from "@/pages/HistoryPage";
import SystemPage from "@/pages/SystemPage";
import VoicesPage from "@/pages/VoicesPage";

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<GeneratePage />} />
        <Route path="/voices" element={<VoicesPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/api" element={<ApiPage />} />
        <Route path="/system" element={<SystemPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
