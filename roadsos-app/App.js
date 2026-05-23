import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, Button } from 'react-native';
import { getNearestServices } from './src/services/DatabaseService';

export default function App() {

  const testOfflineDatabase = async () => {
    try {
      console.log("Searching for nearest hospitals...");
      // Hardcoding coordinates somewhere in Patna for the test
      const testLat = 25.5941; 
      const testLon = 85.1376;
      
      const closestHospitals = await getNearestServices(testLat, testLon, 'hospital');
      
      console.log("SUCCESS! Top 3 closest hospitals:");
      console.log(closestHospitals.slice(0, 3));
    } catch (error) {
      console.error("Database Error:", error);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>RoadSOS Data Test</Text>
      <Button title="TEST DATABASE" onPress={testOfflineDatabase} />
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
  }
});