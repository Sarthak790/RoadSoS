import { useEffect, useState } from 'react';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useColorScheme } from 'react-native';

// Local component imports
import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';

import { initializeSmartVault } from '@/services/DatabaseService'; 
import { useLocationWatcher } from '@/hooks/useLocationWatcher';   

export default function TabLayout() {
  const colorScheme = useColorScheme();
  const [isVaultReady, setIsVaultReady] = useState(false);

  // 1. Boot up the SQLite Vault safely
  useEffect(() => {
    const setupDatabase = async () => {
      try {
        await initializeSmartVault();
        setIsVaultReady(true); // Green light!
      } catch (e) {
        console.error("Vault failed to initialize:", e);
      }
    };
    
    setupDatabase();
  }, []);

  // 2. Ignite the Silent Co-Pilot (Passing the green light)
  const trackerStatus = useLocationWatcher(isVaultReady);
  
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      {/* Optional: You could conditionally render AppTabs here based on isVaultReady, 
          but rendering it immediately is fine if your UI doesn't rely on the DB instantly */}
      <AppTabs />
    </ThemeProvider>
  );
}