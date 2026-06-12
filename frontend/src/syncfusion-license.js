import { registerLicense } from '@syncfusion/ej2-base'

// Prefer .env key; fall back to the key previously in main.jsx.
const licenseKey =
  import.meta.env.VITE_SYNCFUSION_LICENSE ||
  'Ngo9BigBOggjHTQxAR8/V1JHaF5cWWdCf1FpRmJGdld5fUVHYVZUTXxaS00DNHVRdkdlWXlfcXZWRWdfWExwXEdWYEo='

if (licenseKey) {
  registerLicense(licenseKey)
}
