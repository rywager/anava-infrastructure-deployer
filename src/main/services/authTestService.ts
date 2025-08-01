import { ipcMain } from 'electron';
import axios from 'axios';

export class AuthTestService {
  constructor() {
    this.setupIPC();
  }

  private setupIPC() {
    ipcMain.handle('test-auth-step', async (_event, params) => {
      return this.testAuthStep(params);
    });
  }

  async testAuthStep(params: any): Promise<any> {
    try {
      switch (params.step) {
        case 'custom-token':
          return await this.getCustomToken(
            params.apiGatewayUrl,
            params.apiKey,
            params.deviceId
          );
        
        case 'id-token':
          return await this.getIdToken(
            params.customToken,
            params.firebaseApiKey
          );
        
        case 'gcp-token':
          return await this.getGcpToken(
            params.apiGatewayUrl,
            params.apiKey,
            params.idToken
          );
        
        case 'verify':
          return await this.verifyGcpToken(
            params.gcpToken
          );
        
        default:
          throw new Error(`Unknown test step: ${params.step}`);
      }
    } catch (error: any) {
      console.error(`Auth test error at step ${params.step}:`, error);
      
      // Log more details for 400 errors
      if (error.response) {
        console.error('Error response status:', error.response.status);
        console.error('Error response data:', error.response.data);
      }
      
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message || 'Test failed'
      };
    }
  }

  private async getCustomToken(apiGatewayUrl: string, apiKey: string, deviceId: string) {
    console.log('[AuthTest] Step 1: Getting Firebase custom token...');
    
    const response = await axios.post(
      `${apiGatewayUrl}/device-auth/initiate`,
      { device_id: deviceId },
      {
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data?.firebase_custom_token) {
      console.log('[AuthTest] ✅ Got custom token');
      return {
        success: true,
        customToken: response.data.firebase_custom_token
      };
    } else {
      throw new Error('No custom token in response');
    }
  }

  private async getIdToken(customToken: string, firebaseApiKey: string) {
    console.log('[AuthTest] Step 2: Exchanging for Firebase ID token...');
    
    const response = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseApiKey}`,
      {
        token: customToken,
        returnSecureToken: true
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data?.idToken) {
      console.log('[AuthTest] ✅ Got Firebase ID token');
      return {
        success: true,
        idToken: response.data.idToken,
        expiresIn: response.data.expiresIn
      };
    } else {
      throw new Error('No ID token in response');
    }
  }

  private async getGcpToken(apiGatewayUrl: string, apiKey: string, idToken: string) {
    console.log('[AuthTest] Step 3: Exchanging for GCP access token...');
    
    const response = await axios.post(
      `${apiGatewayUrl}/gcp-token/vend`,
      { firebase_id_token: idToken },
      {
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data?.gcp_access_token) {
      console.log('[AuthTest] ✅ Got GCP access token');
      return {
        success: true,
        gcpToken: response.data.gcp_access_token,
        expiresIn: response.data.expires_in
      };
    } else {
      throw new Error('No GCP token in response');
    }
  }

  private async verifyGcpToken(gcpToken: string) {
    console.log('[AuthTest] Step 4: Verifying GCP token...');
    
    try {
      // Test the token by making a simple API call to Cloud Resource Manager
      // This verifies the token works for actual GCP API calls
      const response = await axios.get(
        'https://cloudresourcemanager.googleapis.com/v1/projects',
        {
          headers: {
            'Authorization': `Bearer ${gcpToken}`,
            'Content-Type': 'application/json'
          },
          params: {
            pageSize: 1  // Just get one project to verify the token works
          }
        }
      );

      if (response.status === 200) {
        console.log('[AuthTest] ✅ GCP token is valid!');
        console.log('[AuthTest] Successfully made authenticated API call to GCP');
        
        // Try to get the service account info from the token
        // Note: This might not work for all token types, so we make it optional
        try {
          const tokenInfoResponse = await axios.get(
            'https://www.googleapis.com/oauth2/v1/tokeninfo',
            {
              params: {
                access_token: gcpToken
              }
            }
          );
          
          if (tokenInfoResponse.data?.email) {
            const serviceAccountName = tokenInfoResponse.data.email.split('@')[0];
            console.log(`[AuthTest] Service Account: ${serviceAccountName}@...`);
            
            return {
              success: true,
              serviceAccount: `${serviceAccountName}@...`,
              scope: tokenInfoResponse.data.scope,
              expiresIn: tokenInfoResponse.data.expires_in
            };
          }
        } catch (tokenInfoError) {
          // Token info might not be available for WIF tokens, that's OK
          console.log('[AuthTest] Note: Could not retrieve token info (this is normal for WIF tokens)');
        }
        
        return {
          success: true,
          serviceAccount: 'vertex-ai-sa (via Workload Identity)',
          message: 'Token validated successfully via API call'
        };
      } else {
        throw new Error(`Unexpected response status: ${response.status}`);
      }
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('GCP token is invalid or expired');
      } else if (error.response?.status === 403) {
        throw new Error('GCP token lacks required permissions');
      } else {
        throw new Error(`Token verification failed: ${error.message}`);
      }
    }
  }
}