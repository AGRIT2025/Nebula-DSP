import { BrowserRouter, Routes, Route } from 'react-router-dom'
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
    <BrowserRouter>
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
    </BrowserRouter>
  )
}
