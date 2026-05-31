// HashRouter (not HashRouter): the backend serves the SPA only under
// /gui/, so deep-link URLs like http://host/pipeline would 404 on refresh.
// With HashRouter, the route lives in the URL fragment
// (e.g. /gui/index.html#/pipeline) and refresh always lands on a real
// index.html served by the static handler.
import { HashRouter, Routes, Route } from 'react-router-dom'
import { Layout } from '@/components/ui/Layout'
import { Dashboard } from '@/components/Dashboard/Dashboard'
import { Compressor } from '@/components/Compressor/Compressor'
import { Limiter } from '@/components/Limiter/Limiter'
import { Filters } from '@/components/Filters/Filters'
import { Pipeline } from '@/components/Pipeline/Pipeline'
import { Volume } from '@/components/Volume/Volume'
import { Devices } from '@/components/Devices/Devices'
import { RoomCorrection } from '@/components/RoomCorrection/RoomCorrection'

export default function App() {
  return (
    <HashRouter>
      <Layout>
        <Routes>
          <Route path="/"                element={<Dashboard />}      />
          <Route path="/compressor"      element={<Compressor />}     />
          <Route path="/limiter"         element={<Limiter />}        />
          <Route path="/filters"         element={<Filters />}        />
          <Route path="/pipeline"        element={<Pipeline />}       />
          <Route path="/volume"          element={<Volume />}         />
          <Route path="/devices"         element={<Devices />}        />
          <Route path="/room-correction" element={<RoomCorrection />} />
        </Routes>
      </Layout>
    </HashRouter>
  )
}
